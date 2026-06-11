/**
 * Shared trust-domain seed lists.
 *
 * Single source of truth — imported by both evals/run-evals.ts and
 * scripts/seed-trust-domains.ts to avoid duplication.
 */

export const PROGRAMMING_TIER1_DOMAINS = [
  'developer.mozilla.org', 'docs.python.org', 'doc.rust-lang.org', 'nodejs.org', 'react.dev',
  'go.dev', 'typescriptlang.org', 'docs.oracle.com', 'learn.microsoft.com', 'kubernetes.io',
  'git-scm.com', 'postgresql.org', 'w3.org', 'whatwg.org', 'docs.docker.com',
  'pip.pypa.io', 'packaging.python.org', 'peps.python.org', 'tc39.es', 'gcc.gnu.org',
];

export const PROGRAMMING_TIER2_DOMAINS = [
  'realpython.com', 'web.dev', 'css-tricks.com', 'martinfowler.com', 'refactoring.guru',
  'eloquentjavascript.net', 'javascript.info', 'overreacted.io', 'jvns.ca', 'blog.rust-lang.org',
];

export const HISTORY_TIER1_DOMAINS = [
  'loc.gov', 'archives.gov', 'britannica.com', 'history.state.gov', 'nationalarchives.gov.uk',
  'bl.uk', 'europeana.eu', 'ushmm.org', 'docsteach.org', 'avalon.law.yale.edu',
  'gilderlehrman.org', 'historicengland.org.uk', 'si.edu', 'metmuseum.org', 'britishmuseum.org',
];

export const HISTORY_TIER2_DOMAINS = [
  'worldhistory.org', 'smithsonianmag.com', 'historytoday.com', 'historyextra.com', 'jstor.org',
];

export const MATH_TIER1_DOMAINS = [
  'khanacademy.org', 'mathworld.wolfram.com', 'artofproblemsolving.com', 'nctm.org', 'maa.org',
  'mathigon.org', 'brilliant.org', 'desmos.com', 'mathisfun.com', 'openstax.org',
  'ams.org', 'plus.maths.org', '3blue1brown.com', 'purplemath.com', 'cuemath.com',
];

export const SCIENCE_TIER1_DOMAINS = [
  'nasa.gov', 'noaa.gov', 'nature.com', 'scientificamerican.com', 'nih.gov',
  'science.org', 'nationalgeographic.com', 'exploratorium.edu', 'sciencedaily.com', 'britannica.com',
  'hhmi.org', 'acs.org', 'aps.org', 'physics.org', 'chemguide.co.uk',
];
