import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { researchTopic } from '../src/server/research/research-topic';

async function main() {
  if (process.env.AI_FAKE_LLM === '1') throw new Error('Unset AI_FAKE_LLM for a live smoke.');
  const VALID_BANDS = ['novice', 'developing', 'competent'] as const;
  type LevelBand = typeof VALID_BANDS[number];

  const [topic, vertical = 'programming', levelBand = 'novice'] = process.argv.slice(2);
  if (!topic) {
    console.error(`Usage: npm run research:smoke -- "topic" [vertical] [levelBand]`);
    console.error(`  levelBand must be one of: ${VALID_BANDS.join(', ')}`);
    process.exit(1);
  }
  if (!(VALID_BANDS as readonly string[]).includes(levelBand)) {
    console.error(`Error: levelBand must be one of: ${VALID_BANDS.join(', ')} (got "${levelBand}")`);
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: s });
  const started = Date.now();
  const result = await researchTopic(db, { topic, vertical, levelBand: levelBand as LevelBand });
  console.log(JSON.stringify(result, null, 2));
  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if ('dossierId' in result) {
    const [row] = await db.select().from(s.topicDossiers).where(eq(s.topicDossiers.id, result.dossierId));
    console.log('claims:', JSON.stringify(row.claims, null, 2));
    console.log('sources:', JSON.stringify(row.sources, null, 2));
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
