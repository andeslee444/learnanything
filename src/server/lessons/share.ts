/**
 * share.ts — Core share/unshare logic, extracted for testability.
 *
 * createShareHandlers(db) returns { shareLesson, unshareLesson }.
 * The API route thin-wrappers call these after auth/ownership checks.
 *
 * Slug format: {topic-slug}-{shortid}
 *   topic-slug: lowercase, alnum+hyphens only, consecutive hyphens collapsed, ≤60 chars
 *   shortid: 8 hex-alphabet chars derived from 4 bytes of crypto.randomUUID()
 *
 * Uniqueness: the unique index on shared_lessons.slug is the authoritative backstop.
 * On a collision (extremely rare) we retry once with a fresh shortid.
 * After the retry, if still null (second consecutive collision), we throw — callers
 * must not evaluate 'kind' in null.
 *
 * Badge snapshot shape (stored in badge_snapshot JSONB column):
 * {
 *   overallStatus: 'verified' | 'issues' | 'pending',
 *   faithfulnessScore: number | null,
 *   checkedAt: string | null,   // ISO timestamp of latest verification_result.updated_at
 *   blocks: Array<{ blockId: string; badge: 'verified' | 'unverified' }>
 * }
 *
 * Per-user debounce: a module-level Map prevents concurrent share POSTs from the
 * same learner. Checked after ownership + idempotency so 404s/cached hits are not
 * rate-limited. Window: 5 seconds. Returns { kind: 'too_fast' }.
 *
 * Sticky moderation: admin takedown rows (moderationStatus === 'removed') are not
 * owner-deletable. unshareLesson returns { kind: 'removed_by_moderation' } → route 403.
 * Admin-controlled rows are managed by T3 admin actions — not by the owner.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import { sanitizeLessonContent, SanitizeError } from './sanitize';
import { badgeFor } from './verdicts';

export type { SanitizeError };

type Db = NodePgDatabase<typeof s>;

// ── Badge snapshot type ───────────────────────────────────────────────────────

export type BadgeSnapshotBlock = { blockId: string; badge: 'verified' | 'unverified' };
export type BadgeSnapshot = {
  overallStatus: 'verified' | 'issues' | 'pending';
  faithfulnessScore: number | null;
  checkedAt: string | null;
  blocks: BadgeSnapshotBlock[];
};

// ── Slug helpers ──────────────────────────────────────────────────────────────

/**
 * Slugify a topic string: lowercase, keep alnum + hyphens, collapse repeats, ≤60 chars.
 * Exported for unit testing.
 */
export function slugifyTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alnum runs → single hyphen
    .replace(/^-+|-+$/g, '')        // strip leading/trailing hyphens
    .replace(/-{2,}/g, '-')         // collapse remaining consecutive hyphens
    .slice(0, 60)
    .replace(/-+$/, '');            // strip trailing hyphen after slice
}

/**
 * Generate an 8-char base36-ish shortid from 4 random UUID bytes.
 * Uses only hex chars [0-9a-f] for simplicity and URL safety.
 * Exported for unit testing.
 */
export function makeShortId(): string {
  // crypto.randomUUID() returns "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
  // Take the first 8 hex chars after stripping hyphens — always lowercase alnum.
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * Build the full slug. Accepts an optional shortIdOverride for testing.
 */
export function buildSlug(topic: string, shortIdOverride?: string): string {
  const topicPart = slugifyTopic(topic);
  const short = shortIdOverride ?? makeShortId();
  return topicPart ? `${topicPart}-${short}` : short;
}

// ── Badge snapshot builder ────────────────────────────────────────────────────

export async function buildBadgeSnapshot(
  db: Db,
  lesson: typeof s.lessons.$inferSelect,
): Promise<BadgeSnapshot> {
  const rows = await db
    .select()
    .from(s.verificationResults)
    .where(eq(s.verificationResults.lessonId, lesson.id));

  const blocks: BadgeSnapshotBlock[] = rows.map((r) => ({
    blockId: r.blockId,
    badge: badgeFor(r.claimsVerified, r.claimsTotal),
  }));

  // Latest checkedAt = max(updated_at) across all verification rows.
  let checkedAt: string | null = null;
  if (rows.length > 0) {
    const maxTs = rows.reduce<Date | null>((acc, r) => {
      if (!r.updatedAt) return acc;
      return acc === null || r.updatedAt > acc ? r.updatedAt : acc;
    }, null);
    checkedAt = maxTs ? maxTs.toISOString() : null;
  }

  // Map lesson.verificationStatus (which is the canonical aggregate) to the snapshot.
  // The lesson row's verificationStatus is set by the verify workflow's finalize step.
  const vs = lesson.verificationStatus;
  const overallStatus: BadgeSnapshot['overallStatus'] =
    vs === 'verified' ? 'verified' : vs === 'issues' ? 'issues' : 'pending';

  return {
    overallStatus,
    faithfulnessScore: lesson.faithfulnessScore ?? null,
    checkedAt,
    blocks,
  };
}

// ── Share result / error types ────────────────────────────────────────────────

export type ShareSuccess = {
  slug: string;
  url: string;
  vertical: string;
  alreadyExisted: boolean;
};

export type ShareError =
  | { kind: 'sanitize_unavailable'; retryable: true }
  | { kind: 'cannot_share'; reason: string }
  | { kind: 'too_fast' }
  | { kind: 'removed_by_moderation' };

// ── Per-user in-process debounce ──────────────────────────────────────────────

/**
 * Module-level debounce map. Key = learnerId, value = timestamp of last share call.
 * Cleared automatically after DEBOUNCE_MS to avoid memory growth.
 * Only consulted for new shares (after ownership + idempotency checks).
 */
const _shareDebounceMap = new Map<string, number>();
const DEBOUNCE_MS = 5_000;

/** Exported for testing — allows tests to clear debounce state between calls. */
export function _clearShareDebounce(learnerId?: string): void {
  if (learnerId) {
    _shareDebounceMap.delete(learnerId);
  } else {
    _shareDebounceMap.clear();
  }
}

// ── createShareHandlers ───────────────────────────────────────────────────────

export function createShareHandlers(db: Db) {
  /**
   * Share a lesson. Idempotent: existing row → returns the same slug/URL.
   *
   * Ownership check is the route's responsibility (resolveOwnership).
   * Debounce (5s per learnerId) is checked after idempotency — cache hits bypass it.
   *
   * @throws never — all errors are returned as ShareError discriminated union.
   */
  async function shareLesson(
    lesson: typeof s.lessons.$inferSelect,
    track: typeof s.tracks.$inferSelect,
    opts?: {
      /** Override shortid generation — for testing slug-collision scenarios */
      shortIdGen?: () => string;
    },
  ): Promise<ShareSuccess | ShareError> {
    // ── Idempotency: already shared ─────────────────────────────────────────
    const [existing] = await db
      .select({
        slug: s.sharedLessons.slug,
        vertical: s.sharedLessons.vertical,
        moderationStatus: s.sharedLessons.moderationStatus,
      })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.lessonId, lesson.id));

    if (existing) {
      // Return existing row regardless of moderationStatus — do NOT modify the row.
      // Admin-controlled rows (moderationStatus 'removed') are not re-approved here.
      const vert = existing.vertical || track.vertical;
      return {
        slug: existing.slug,
        url: `/learn/${vert}/${existing.slug}`,
        vertical: vert,
        alreadyExisted: true,
      };
    }

    // ── Per-user debounce (5s) ───────────────────────────────────────────────
    // Only for new shares (idempotency hit above bypasses this).
    // Keyed by track.learnerId so only the same user is rate-limited.
    const learnerId = track.learnerId;
    const lastCall = _shareDebounceMap.get(learnerId);
    const now = Date.now();
    if (lastCall !== undefined && now - lastCall < DEBOUNCE_MS) {
      return { kind: 'too_fast' };
    }
    _shareDebounceMap.set(learnerId, now);
    // Auto-clean after debounce window to avoid memory growth.
    setTimeout(() => {
      if (_shareDebounceMap.get(learnerId) === now) {
        _shareDebounceMap.delete(learnerId);
      }
    }, DEBOUNCE_MS);

    // ── Sanitize ─────────────────────────────────────────────────────────────
    let sanitizeResult: Awaited<ReturnType<typeof sanitizeLessonContent>>;
    try {
      sanitizeResult = await sanitizeLessonContent(db, lesson);
    } catch (err) {
      if (err instanceof SanitizeError) {
        if (err.retryable) {
          return { kind: 'sanitize_unavailable', retryable: true };
        }
        // Fail closed — never publish on a failed gate (spec §7).
        return { kind: 'cannot_share', reason: err.message };
      }
      throw err;
    }

    // ── Badge snapshot ────────────────────────────────────────────────────────
    const badgeSnapshot = await buildBadgeSnapshot(db, lesson);

    // ── Slug with retry-once on collision ─────────────────────────────────────
    const topic = (lesson.spec as { topic?: string })?.topic ?? track.topic;
    const shortIdGen = opts?.shortIdGen ?? makeShortId;

    const tryInsert = async (): Promise<ShareSuccess | null> => {
      const slug = buildSlug(topic, shortIdGen());

      try {
        await db.insert(s.sharedLessons).values({
          lessonId: lesson.id,
          sanitizedContent: sanitizeResult.content as Record<string, unknown>,
          slug,
          vertical: track.vertical,
          moderationStatus: 'approved',
          verificationStatus: lesson.verificationStatus,
          badgeSnapshot: badgeSnapshot as Record<string, unknown>,
          publishedAt: new Date(),
        });

        return {
          slug,
          url: `/learn/${track.vertical}/${slug}`,
          vertical: track.vertical,
          alreadyExisted: false,
        };
      } catch (err) {
        // Unique constraint violation on slug → return null (sentinel for retry).
        // Drizzle wraps the PG error inside DrizzleQueryError.cause.
        // The pg driver sets code=23505 and constraint='shared_lessons_slug_unique'.
        // We check both the outer err and the cause to be robust.
        type PgLike = { code?: string; constraint?: string; message?: string };
        const outer = err as PgLike;
        const cause = (err as { cause?: PgLike })?.cause;
        const pgErr = cause ?? outer;
        const is23505 = pgErr.code === '23505' || outer.code === '23505';
        const hasSlugConstraint =
          pgErr.constraint?.includes('slug') ??
          outer.constraint?.includes('slug') ??
          pgErr.message?.toLowerCase().includes('slug') ??
          outer.message?.toLowerCase().includes('slug') ??
          false;
        if (is23505 && hasSlugConstraint) {
          return null; // sentinel for retry
        }

        // Concurrent double-share: unique constraint on lesson_id (not slug).
        // The loser of a check-then-insert race hits 23505 on shared_lessons_lesson_id_unique.
        // Re-select the row and return it with alreadyExisted=true (idempotent 200).
        const hasLessonConstraint =
          pgErr.constraint?.includes('lesson_id') ??
          outer.constraint?.includes('lesson_id') ??
          pgErr.message?.toLowerCase().includes('lesson_id') ??
          outer.message?.toLowerCase().includes('lesson_id') ??
          false;
        if (is23505 && hasLessonConstraint) {
          const [raceRow] = await db
            .select({ slug: s.sharedLessons.slug, vertical: s.sharedLessons.vertical })
            .from(s.sharedLessons)
            .where(eq(s.sharedLessons.lessonId, lesson.id));
          if (raceRow) {
            const vert = raceRow.vertical || track.vertical;
            return {
              slug: raceRow.slug,
              url: `/learn/${vert}/${raceRow.slug}`,
              vertical: vert,
              alreadyExisted: true,
            };
          }
        }

        throw err;
      }
    };

    const first = await tryInsert();
    // If slug collision, retry once
    if (first === null) {
      const second = await tryInsert();
      if (second === null) {
        // Two consecutive slug collisions — astronomically unlikely but guard the contract.
        throw new Error('slug collision persisted after retry');
      }
      return second;
    }
    return first;
  }

  /**
   * Unshare a lesson. Idempotent: no row → still returns success (no-op).
   *
   * Admin takedown guard: if the existing row's moderationStatus === 'removed',
   * this returns { kind: 'removed_by_moderation' } — the owner cannot delete
   * a row that an admin has taken down. T3 admin actions manage these rows.
   */
  async function unshareLesson(
    lessonId: string,
  ): Promise<void | { kind: 'removed_by_moderation' }> {
    const [existing] = await db
      .select({ moderationStatus: s.sharedLessons.moderationStatus })
      .from(s.sharedLessons)
      .where(eq(s.sharedLessons.lessonId, lessonId));

    if (!existing) {
      // No row → idempotent no-op.
      return;
    }

    if (existing.moderationStatus === 'removed') {
      // Admin-controlled row — not owner-deletable.
      // T3 admin actions manage rows with moderationStatus 'removed'.
      return { kind: 'removed_by_moderation' };
    }

    await db.delete(s.sharedLessons).where(eq(s.sharedLessons.lessonId, lessonId));
  }

  return { shareLesson, unshareLesson };
}
