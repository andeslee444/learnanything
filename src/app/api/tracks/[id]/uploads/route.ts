import { eq, and, count, desc } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import * as s from '@/db/schema';
import { getLearnerByUserId } from '@/server/learners';
import { getTrackDetail } from '@/server/tracks';
import { moderateText } from '@/server/moderation';
import { extractSource } from '@/server/research/extract';
import type { AgeBand } from '@/lib/age-band';

const MAX_UPLOADS_PER_TRACK = 10;
const MAX_TEXT_LENGTH = 200_000;
const MAX_FILENAME_LENGTH = 120;
const ANNOTATION_MAX_CHARS = 300;

/** Validate that the filename ends in .txt or .md (case-insensitive). */
function hasAllowedExtension(filename: string): boolean {
  return /\.(txt|md)$/i.test(filename);
}

const uploadBodySchema = z.object({
  filename: z
    .string()
    .max(MAX_FILENAME_LENGTH)
    .refine(hasAllowedExtension, { message: 'Only .txt and .md files are accepted' }),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });
  const detail = await getTrackDetail(db, id, learner.id);
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const uploads = await db
    .select({
      id: s.resources.id,
      title: s.resources.title,
      annotation: s.resources.annotation,
      createdAt: s.resources.createdAt,
    })
    .from(s.resources)
    .where(and(eq(s.resources.trackId, id), eq(s.resources.origin, 'user_upload')))
    .orderBy(desc(s.resources.createdAt));

  return NextResponse.json({ uploads });
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  // Auth ladder (mirrors lessons/route.ts)
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const learner = await getLearnerByUserId(db, session.user.id);
  if (!learner) return NextResponse.json({ error: 'no learner profile' }, { status: 403 });

  const detail = await getTrackDetail(db, id, learner.id);
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Parse request body
  let body: unknown;
  try {
    body = await _req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parse = uploadBodySchema.safeParse(body);
  if (!parse.success) {
    const issue = parse.error.issues[0];
    return NextResponse.json(
      { error: 'validation_error', message: issue.message },
      { status: 422 },
    );
  }
  const { filename, text } = parse.data;

  // Cap: 10 uploads per track
  const [countRow] = await db
    .select({ n: count() })
    .from(s.resources)
    .where(
      and(
        eq(s.resources.trackId, id),
        eq(s.resources.origin, 'user_upload'),
      ),
    );
  const uploadCount = Number(countRow?.n ?? 0);
  if (uploadCount >= MAX_UPLOADS_PER_TRACK) {
    return NextResponse.json(
      { error: 'upload_cap_reached', message: `Maximum ${MAX_UPLOADS_PER_TRACK} uploads per track` },
      { status: 409 },
    );
  }

  // Moderate (context 'retrieved_content', learner's ageBand)
  const ageBand = learner.ageBand as AgeBand;
  const modResult = await moderateText(text, 'retrieved_content', { ageBand });
  if (!modResult.allowed) {
    return NextResponse.json(
      {
        error: 'content_flagged',
        message: modResult.errored
          ? 'Safety check temporarily unavailable — please try again'
          : 'This content was flagged and cannot be used',
      },
      { status: 422 },
    );
  }

  // Quarantined extraction — raw text is then DISCARDED (spec §6)
  const uploadId = crypto.randomUUID();
  const pseudoUrl = `upload://${uploadId}`;
  const extraction = await extractSource(
    { title: filename, url: pseudoUrl, text },
    detail.track.topic,
  );
  // raw text no longer referenced from here — only extraction persists

  // Build annotation: first 2 claims joined (≤300 chars) or fallback
  const claimTexts = extraction.claims.slice(0, 2).map((c) => c.claim);
  const rawAnnotation = claimTexts.length > 0
    ? claimTexts.join(' | ')
    : 'learner-provided context';
  const annotation = rawAnnotation.slice(0, ANNOTATION_MAX_CHARS);

  // Insert resource — no raw text stored anywhere in the row
  const [resource] = await db
    .insert(s.resources)
    .values({
      trackId: id,
      title: filename,
      url: pseudoUrl,
      resourceType: 'article',
      kind: 'knowledge',
      origin: 'user_upload',
      annotation,
      extraction: extraction as typeof s.resources.$inferInsert['extraction'],
    })
    .returning();

  return NextResponse.json({ resourceId: resource.id, annotation }, { status: 201 });
}
