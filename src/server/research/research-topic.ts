import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@/db/schema';
import { MODEL_TIERS } from '@/lib/ai';
import { moderateText } from '@/server/moderation';
import type { AgeBand } from '@/lib/age-band';
import { findDossier, saveDossier, type DossierKey } from './dossier-cache';
import { extractSource } from './extract';
import { getResearchProvider, type ResearchProvider, type SearchSource } from './provider';
import { synthesizeDossier } from './synthesize';
import { getAllowlist, getBlocklist, normalizeDomain, safeHref, vetSources } from './trust';

type Db = NodePgDatabase<typeof s>;

const MIN_VETTED_SOURCES = 3; // spec §2 step 2
const MAX_SOURCES_TO_EXTRACT = 8;

export type ResearchResult =
  | { status: 'hit'; dossierId: string; claims: number }
  | { status: 'built'; dossierId: string; claims: number; vettedSources: number }
  | { status: 'insufficient_sources'; vettedSources: number }
  | { status: 'blocked'; retryable: boolean };

/**
 * Spec §2 step 2: cache → allowlist search → (if <3 vetted) open web + blocklist → re-vet →
 * still <3 → insufficient (never parametric-only) → quarantined extraction → synthesis → persist.
 *
 * @param ageBand — optional learner age band threaded to all moderateText calls.
 *   NOTE: levelBand (expertise) and ageBand (age) are distinct — levelBand is for pedagogy,
 *   ageBand is for safety policy. The smoke script defaults conservative (no band → '13_15').
 */
export async function researchTopic(
  db: Db,
  key: DossierKey,
  deps: { provider?: ResearchProvider; ageBand?: AgeBand } = {}
): Promise<ResearchResult> {
  const { ageBand } = deps;
  const moderation = await moderateText(key.topic, 'learning_request', { ageBand });
  if (!moderation.allowed) return { status: 'blocked', retryable: !!moderation.errored };

  const cached = await findDossier(db, key);
  if (cached) {
    return { status: 'hit', dossierId: cached.id, claims: cached.claims.length };
  }

  const provider = deps.provider ?? (await getResearchProvider());
  const allowlist = await getAllowlist(db, key.vertical);
  const query = `${key.topic} (${key.vertical}) — for a ${key.levelBand} learner`;

  // Pass 1: allowlist-first. Everything returned is pre-trusted (tier 1/2).
  const fromAllowlist = allowlist.length > 0 ? await provider.search({ query, includeDomains: allowlist }) : [];
  let trusted: SearchSource[] = dedupeByUrl(fromAllowlist);

  // Pass 2 (only if needed): open web minus blocklist, then LLM vetting.
  if (trusted.length < MIN_VETTED_SOURCES) {
    const blocklist = await getBlocklist(db);
    const open = await provider.search({ query, excludeDomains: blocklist });
    const alreadyHave = new Set(trusted.map((src) => safeHref(src.url)));
    const allowSet = new Set(allowlist);
    const candidates = dedupeByUrl(open).filter((src) => !alreadyHave.has(safeHref(src.url)));
    const preTrusted = candidates.filter((src) => allowSet.has(normalizeDomain(src.url)));
    const needVetting = candidates.filter((src) => !allowSet.has(normalizeDomain(src.url)));
    const vetted = (await vetSources(needVetting)).filter((v) => v.trusted);
    trusted = dedupeByUrl([...trusted, ...preTrusted, ...vetted]);
  }

  if (trusted.length < MIN_VETTED_SOURCES) {
    return { status: 'insufficient_sources', vettedSources: trusted.length };
  }

  // Quarantined extraction per source (content moderation rides on the extraction output).
  const toExtract = trusted.slice(0, MAX_SOURCES_TO_EXTRACT);
  const extractions = [];
  let anyContentCheckErrored = false;
  for (const source of toExtract) {
    const extraction = await extractSource(source, key.topic);
    const contentCheck = await moderateText(
      JSON.stringify({ claims: extraction.claims, glossarySeeds: extraction.glossarySeeds, misconceptions: extraction.misconceptions }),
      'retrieved_content',
      { ageBand },
    );
    if (contentCheck.errored) anyContentCheckErrored = true;
    if (contentCheck.allowed) extractions.push(extraction);
  }
  if (extractions.length === 0) {
    // Moderation outage (all checks errored) is retryable; genuine flagging is not.
    if (anyContentCheckErrored) return { status: 'blocked', retryable: true };
    return { status: 'insufficient_sources', vettedSources: trusted.length };
  }

  // Build sources from SURVIVING extractions only — dropped sources must not appear in citations.
  const survivingUrls = new Set(extractions.map((e) => e.sourceUrl));
  const sources = toExtract
    .filter((src) => survivingUrls.has(src.url))
    .map((src) => ({ url: src.url, title: src.title, publishedDate: src.publishedDate }));
  const content = await synthesizeDossier(key.topic, key.levelBand, extractions, sources);

  // Degenerate-dossier floor: if the citation guard left fewer than 3 claims, the dossier
  // is too thin to be useful — report insufficient_sources without persisting.
  if (content.claims.length < 3) {
    return { status: 'insufficient_sources', vettedSources: trusted.length };
  }

  const dossierId = await saveDossier(db, key, content, MODEL_TIERS.generator);
  return { status: 'built', dossierId, claims: content.claims.length, vettedSources: trusted.length };
}

function dedupeByUrl<T extends { url: string }>(sources: T[]): T[] {
  return [...new Map(sources.map((src) => [safeHref(src.url), src])).values()];
}
