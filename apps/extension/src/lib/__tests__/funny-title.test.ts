import { describe, it, expect } from 'vitest';
import { funnyCaptureTitle, titleIsUnusable } from '../funny-title';

describe('titleIsUnusable', () => {
  it('flags empty and too-short titles', () => {
    expect(titleIsUnusable('')).toBe(true);
    expect(titleIsUnusable('  ')).toBe(true);
    expect(titleIsUnusable('ab')).toBe(true);
  });

  it('flags a runaway paragraph-as-heading title', () => {
    const runaway = 'hf-notifications: the fetch agent produced a real grounded summary of the actual discussions and it is now visible in the results file.';
    expect(titleIsUnusable(runaway)).toBe(true);
  });

  it('accepts a normal title', () => {
    expect(titleIsUnusable('Suzuki DL 650 V-Strom review')).toBe(false);
  });
});

describe('funnyCaptureTitle', () => {
  it('returns a non-empty short title', () => {
    const t = funnyCaptureTitle();
    expect(t.length).toBeGreaterThan(3);
    expect(t.length).toBeLessThan(60);
  });

  it('is stable for a given seed — a re-capture keeps its name', () => {
    const a = funnyCaptureTitle('https://example.com/x');
    const b = funnyCaptureTitle('https://example.com/x');
    expect(a).toBe(b);
  });

  it('different seeds can pick different titles', () => {
    const seeds = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`);
    const picks = new Set(seeds.map(s => funnyCaptureTitle(s)));
    expect(picks.size).toBeGreaterThan(1); // not collapsing to one
  });
});
