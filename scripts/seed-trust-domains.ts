import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import 'dotenv/config';
import * as s from '../src/db/schema';

const SEEDS: Array<{ vertical: string | null; domain: string; tier: 'tier1' | 'tier2' | 'tier3' | 'blocked'; note?: string }> = [
  // ── programming: tier 1 (primary/official) ──
  ...[
    'developer.mozilla.org', 'docs.python.org', 'doc.rust-lang.org', 'nodejs.org', 'react.dev',
    'go.dev', 'typescriptlang.org', 'docs.oracle.com', 'learn.microsoft.com', 'kubernetes.io',
    'git-scm.com', 'postgresql.org', 'w3.org', 'whatwg.org', 'docs.docker.com',
    'pip.pypa.io', 'packaging.python.org', 'peps.python.org', 'tc39.es', 'gcc.gnu.org',
  ].map((domain) => ({ vertical: 'programming', domain, tier: 'tier1' as const, note: 'official docs/standards' })),
  // ── programming: tier 2 (recognized experts/editorial) ──
  ...[
    'realpython.com', 'web.dev', 'css-tricks.com', 'martinfowler.com', 'refactoring.guru',
    'eloquentjavascript.net', 'javascript.info', 'overreacted.io', 'jvns.ca', 'blog.rust-lang.org',
  ].map((domain) => ({ vertical: 'programming', domain, tier: 'tier2' as const, note: 'recognized expert/editorial' })),
  // ── history: tier 1 (primary/institutional) ──
  ...[
    'loc.gov', 'archives.gov', 'britannica.com', 'history.state.gov', 'nationalarchives.gov.uk',
    'bl.uk', 'europeana.eu', 'ushmm.org', 'docsteach.org', 'avalon.law.yale.edu',
    'gilderlehrman.org', 'historicengland.org.uk', 'si.edu', 'metmuseum.org', 'britishmuseum.org',
  ].map((domain) => ({ vertical: 'history', domain, tier: 'tier1' as const, note: 'primary/institutional' })),
  // ── history: tier 2 ──
  ...[
    'worldhistory.org', 'smithsonianmag.com', 'historytoday.com', 'historyextra.com', 'jstor.org',
  ].map((domain) => ({ vertical: 'history', domain, tier: 'tier2' as const, note: 'reputable editorial' })),
  // ── global blocklist (vertical = null) ──
  ...[
    'pinterest.com', 'quora.com', 'answers.com', 'coursehero.com', 'scribd.com',
    'brainly.com', 'chegg.com', 'studocu.com', 'slideshare.net', 'prezi.com',
  ].map((domain) => ({ vertical: null, domain, tier: 'blocked' as const, note: 'answer mill / low-signal aggregator' })),
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: s });
  const inserted = await db.insert(s.trustDomains).values(SEEDS).onConflictDoNothing().returning({ id: s.trustDomains.id });
  console.log(`trust_domains: ${inserted.length} inserted, ${SEEDS.length - inserted.length} already present`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
