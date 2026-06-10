export type AgeBand = '13_15' | '16_17' | '18_plus';

/**
 * Conservative banding from birth YEAR only (data minimization — we never store DOB).
 * Uses the age the person turns this calendar year, so someone who hasn't had their
 * birthday yet may be banded one year up — conservative is fine; under-13 banding
 * errs the other way: we require the year they turn 13 to have started.
 */
export function ageBandFromBirthYear(birthYear: number, now = new Date()): AgeBand | null {
  const ageThisYear = now.getUTCFullYear() - birthYear;
  if (ageThisYear < 13) return null;
  if (ageThisYear <= 15) return '13_15';
  if (ageThisYear <= 17) return '16_17';
  return '18_plus';
}
