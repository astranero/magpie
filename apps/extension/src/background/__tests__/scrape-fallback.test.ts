import { describe, it, expect } from 'vitest';
import { extractDoi } from '../../lib/quality-gate';

describe('extractDoi utility', () => {
  it('extracts DOI from plain DOI URL', () => {
    expect(extractDoi('https://doi.org/10.1234/abcd.ef')).toBe('10.1234/abcd.ef');
  });
  it('extracts DOI from publisher URL', () => {
    expect(extractDoi('https://dl.acm.org/doi/10.1145/3583133.3596373')).toBe('10.1145/3583133.3596373');
  });
  it('returns null if no DOI', () => {
    expect(extractDoi('https://example.com/page')).toBeNull();
  });
  it('trims trailing punctuation', () => {
    expect(extractDoi('https://doi.org/10.1234/abcd.ef.')).toBe('10.1234/abcd.ef');
  });
});
