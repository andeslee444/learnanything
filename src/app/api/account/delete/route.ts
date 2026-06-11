/**
 * POST /api/account/delete
 *
 * Session-authenticated. Body must be { confirm: 'DELETE' } — 400 otherwise.
 *
 * Deletes the user row; FK cascades remove all child data.
 * After deletion: clears the Better-Auth session cookie so the browser
 * doesn't hold a stale token. (The session DB row is already gone via cascade.)
 *
 * Exports:
 *   createPostHandler(db) — factory for test injection.
 *   POST                  — production handler.
 */

import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { deleteAccount } from '@/lib/account-delete';
import type * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

// Better-Auth session cookie name (default cookiePrefix "better-auth"):
// see node_modules/better-auth/dist/cookies/index.mjs line 25-26, 46.
const SESSION_COOKIE_NAME = 'better-auth.session_token';

export function createPostHandler(database: Db) {
  return async function POST(req: NextRequest) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      (body as Record<string, unknown>).confirm !== 'DELETE'
    ) {
      return NextResponse.json(
        { error: 'Body must be { "confirm": "DELETE" }' },
        { status: 400 }
      );
    }

    await deleteAccount(database, session.user.id);

    // Clear the session cookie so the browser discards it immediately.
    // The DB session row is already gone (cascade from user deletion).
    const response = NextResponse.json({ deleted: true }, { status: 200 });
    response.cookies.set(SESSION_COOKIE_NAME, '', {
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    return response;
  };
}

export const POST = createPostHandler(db);
