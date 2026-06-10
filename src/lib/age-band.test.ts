import { describe, it, expect } from 'vitest';
import { ageBandFromBirthYear } from './age-band';

describe('ageBandFromBirthYear', () => {
  const now = new Date('2026-06-10');
  it('maps under-13 to null (blocked, never stored)', () => {
    expect(ageBandFromBirthYear(2015, now)).toBeNull(); // turns 11 this year
    expect(ageBandFromBirthYear(2014, now)).toBeNull(); // turns 12
  });
  it('maps 13-15', () => {
    expect(ageBandFromBirthYear(2013, now)).toBe('13_15'); // turns 13
    expect(ageBandFromBirthYear(2011, now)).toBe('13_15'); // turns 15
  });
  it('maps 16-17', () => {
    expect(ageBandFromBirthYear(2010, now)).toBe('16_17');
    expect(ageBandFromBirthYear(2009, now)).toBe('16_17');
  });
  it('maps 18+', () => {
    expect(ageBandFromBirthYear(2008, now)).toBe('18_plus');
    expect(ageBandFromBirthYear(1980, now)).toBe('18_plus');
  });
});
