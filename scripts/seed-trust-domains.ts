import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import 'dotenv/config';
import * as s from '../src/db/schema';
import {
  PROGRAMMING_TIER1_DOMAINS,
  PROGRAMMING_TIER2_DOMAINS,
  HISTORY_TIER1_DOMAINS,
  HISTORY_TIER2_DOMAINS,
  MATH_TIER1_DOMAINS,
  SCIENCE_TIER1_DOMAINS,
} from '../src/lib/trust-seed-domains';

const SEEDS: Array<{ vertical: string | null; domain: string; tier: 'tier1' | 'tier2' | 'tier3' | 'blocked'; note?: string }> = [
  // ── programming: tier 1 (primary/official) ──
  ...PROGRAMMING_TIER1_DOMAINS.map((domain) => ({ vertical: 'programming', domain, tier: 'tier1' as const, note: 'official docs/standards' })),
  // ── programming: tier 2 (recognized experts/editorial) ──
  ...PROGRAMMING_TIER2_DOMAINS.map((domain) => ({ vertical: 'programming', domain, tier: 'tier2' as const, note: 'recognized expert/editorial' })),
  // ── history: tier 1 (primary/institutional) ──
  ...HISTORY_TIER1_DOMAINS.map((domain) => ({ vertical: 'history', domain, tier: 'tier1' as const, note: 'primary/institutional' })),
  // ── history: tier 2 ──
  ...HISTORY_TIER2_DOMAINS.map((domain) => ({ vertical: 'history', domain, tier: 'tier2' as const, note: 'reputable editorial' })),
  // ── math: tier 1 ──
  ...MATH_TIER1_DOMAINS.map((domain) => ({ vertical: 'math', domain, tier: 'tier1' as const, note: 'recognized math education resource' })),
  // ── science: tier 1 ──
  ...SCIENCE_TIER1_DOMAINS.map((domain) => ({ vertical: 'science', domain, tier: 'tier1' as const, note: 'recognized science institution/publication' })),
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
