/**
 * GET /api/account/export?format=json|markdown
 *
 * Session-authenticated. Builds and streams the user's complete data export.
 *
 * Exports:
 *   createGetHandler(db) — factory for test injection.
 *   GET                  — production handler.
 */

import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { buildExport, type ExportFormat } from '@/lib/account-export';
import type * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

export function createGetHandler(database: Db) {
  return async function GET(req: NextRequest) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const format = (req.nextUrl.searchParams.get('format') ?? 'json') as ExportFormat;
    if (format !== 'json' && format !== 'markdown') {
      return NextResponse.json(
        { error: 'Invalid format. Use ?format=json or ?format=markdown' },
        { status: 400 }
      );
    }

    const result = await buildExport(database, session.user.id, format);

    return new NextResponse(result.body, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    });
  };
}

export const GET = createGetHandler(db);
