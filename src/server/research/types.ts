/**
 * Shared structural types for the research layer.
 * No imports — this file is consumed by both the DB schema layer and the server layer
 * to avoid a schema → server import cycle.
 */

export type DossierSource = { url: string; title: string; publishedDate?: string };

export type DossierClaim = { claim: string; sourceUrls: string[] };

export type DossierGlossarySeed = { term: string; definition: string };

export type DossierContent = {
  sources: DossierSource[];
  claims: DossierClaim[];
  glossarySeeds: DossierGlossarySeed[];
  misconceptions: string[];
};
