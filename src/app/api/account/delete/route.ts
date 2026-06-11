/**
 * POST /api/account/delete
 *
 * Session-authenticated. Body must be { confirm: 'DELETE' } — 400 otherwise.
 *
 * Active-subscription guard: if the user has an active Stripe subscription,
 * returns 409 { error: 'active_subscription' } and deletes nothing. The user
 * must cancel in the billing portal first; deleting the account does NOT cancel
 * Stripe billing automatically.
 *
 * Deletes the user row; FK cascades remove all child data.
 * After deletion: clears the Better-Auth session cookie so the browser
 * doesn't hold a stale token. (The session DB row is already gone via cascade.)
 * Both the plain cookie name and the __Secure- prefixed variant (used by
 * Better-Auth when baseURL is https in production) are cleared so browsers
 * on HTTPS don't hold a stale token regardless of which name was set.
 *
 * Exports:
 *   createPostHandler(db) — factory for test injection.
 *   POST                  — production handler.
 */

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { deleteAccount } from '@/lib/account-delete';
import * as s from '@/db/schema';

type Db = NodePgDatabase<typeof s>;

// Better-Auth session cookie name (default cookiePrefix "better-auth"):
// see node_modules/better-auth/dist/cookies/index.mjs line 25-26, 46.
const SESSION_COOKIE_NAME = 'better-auth.session_token';
// On HTTPS/production, Better-Auth prepends __Secure- to the cookie name.
// We clear both so the browser discards the token regardless of which was set.
const SESSION_COOKIE_NAME_SECURE = '__Secure-better-auth.session_token';

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

    // Active-subscription guard — must cancel Stripe billing before deleting.
    // Deleting the account does NOT cancel an active Stripe subscription.
    const [billing] = await database
      .select({ subscriptionStatus: s.billingCustomers.subscriptionStatus })
      .from(s.billingCustomers)
      .where(eq(s.billingCustomers.userId, session.user.id))
      .limit(1);

    if (billing?.subscriptionStatus === 'active') {
      return NextResponse.json(
        {
          error: 'active_subscription',
          message:
            'Cancel your subscription in the billing portal before deleting your account.',
        },
        { status: 409 }
      );
    }

    await deleteAccount(database, session.user.id);

    // Clear the session cookie so the browser discards it immediately.
    // The DB session row is already gone (cascade from user deletion).
    const response = NextResponse.json({ deleted: true }, { status: 200 });
    // Plain cookie (used on HTTP / dev).
    response.cookies.set(SESSION_COOKIE_NAME, '', {
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    // __Secure- prefixed cookie (used on HTTPS / production — Better-Auth adds
    // this prefix automatically when baseURL is https).
    response.cookies.set(SESSION_COOKIE_NAME_SECURE, '', {
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
    return response;
  };
}

export const POST = createPostHandler(db);
