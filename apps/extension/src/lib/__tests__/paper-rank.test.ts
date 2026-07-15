import { describe, it, expect } from 'vitest';
import { paperQualityScore, rankPapers } from '../paper-rank';

const NOW = 2026;

describe('paperQualityScore', () => {
  it('scores highly-cited above uncited, same year', () => {
    const a = paperQualityScore({ title: 'a', year: '2020', citations: 500 }, NOW);
    const b = paperQualityScore({ title: 'b', year: '2020', citations: 0 }, NOW);
    expect(a).toBeGreaterThan(b);
  });
  it('citation velocity lets strong recent work beat stale classics', () => {
    const recent = paperQualityScore({ title: 'r', year: '2025', citations: 120 }, NOW);
    const stale = paperQualityScore({ title: 's', year: '2008', citations: 300 }, NOW);
    expect(recent).toBeGreaterThan(stale);
  });
  it('citation velocity is a real term: same citations, fresher paper gains more than recency alone', () => {
    // recency contributes at most 1.0; the velocity term must push the gap
    // for equal-citation papers of different ages beyond that.
    const fresh = paperQualityScore({ title: 'f', year: '2025', citations: 200 }, NOW);
    const old_ = paperQualityScore({ title: 'o', year: '2015', citations: 200 }, NOW);
    expect(fresh - old_).toBeGreaterThan(1.2);
  });

  it('full text adds a bonus', () => {
    const base = { title: 'x', year: '2023', citations: 10 };
    expect(paperQualityScore({ ...base, hasFullText: true }, NOW))
      .toBeGreaterThan(paperQualityScore(base, NOW));
  });
});

describe('rankPapers', () => {
  const mk = (title: string, year: number, citations: number) => ({ title, year: String(year), citations });

  it('returns all sorted when under limit', () => {
    const out = rankPapers([mk('low', 2020, 1), mk('high', 2020, 1000)], 5, NOW);
    expect(out[0].title).toBe('high');
    expect(out.length).toBe(2);
  });

  it('reserves ~30% of slots for newest papers regardless of citations', () => {
    const papers = [
      ...Array.from({ length: 10 }, (_, i) => mk(`classic${i}`, 2015, 5000 - i)),
      mk('brandnew1', 2026, 0),
      mk('brandnew2', 2026, 0)
    ];
    const out = rankPapers(papers, 10, NOW);
    const titles = out.map(p => p.title);
    expect(titles).toContain('brandnew1');
    expect(titles).toContain('brandnew2');
    // 7 quality slots + 3 frontier slots (2 brand-new + next-newest classic)
    expect(titles.filter(t => t.startsWith('classic')).length).toBe(8);
  });

  it('never duplicates picks', () => {
    const papers = Array.from({ length: 20 }, (_, i) => mk(`p${i}`, 2010 + i % 16, i * 10));
    const out = rankPapers(papers, 12, NOW);
    expect(new Set(out.map(p => p.title)).size).toBe(12);
  });
});

describe('venue prestige', () => {
  it('a landmark venue outscores an obscure one, all else equal', () => {
    const base = { title: 'x', year: '2020', citations: 10 };
    const top = paperQualityScore({ ...base, venue: 'NeurIPS 2020' }, NOW);
    const obscure = paperQualityScore({ ...base, venue: 'Intl. Workshop on Things' }, NOW);
    expect(top).toBeGreaterThan(obscure);
    expect(top - obscure).toBeCloseTo(1.0, 5);
  });
  it('no venue = no venue bonus', () => {
    const base = { title: 'x', year: '2020', citations: 10 };
    expect(paperQualityScore(base, NOW)).toBe(paperQualityScore({ ...base, venue: 'Random Journal' }, NOW));
  });
});
