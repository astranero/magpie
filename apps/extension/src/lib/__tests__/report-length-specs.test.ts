import { describe, it, expect } from 'vitest';
import { REPORT_LENGTH_SPECS, type ReportLength } from '../research-limits';

// Reports were landing near 4000 words on the DEFAULT setting, which reads as
// an essay in a 400px side panel. The cause was arithmetic, not the model: the
// per-section budget multiplied out to far more than the stated total, so a
// model obeying the section rule necessarily blew the total.
//
// These tests hold the two numbers to each other. They are cheap and they catch
// the thing a human eye slides over — that 4-8 sections x 300-700 words is
// 1200-5600, sold to the user as "1800-3000".

const KEYS: ReportLength[] = ['concise', 'standard', 'comprehensive'];

function range(s: string): [number, number] {
  // Specs use an en dash in the word ranges and a hyphen in section counts.
  const nums = s.split(/[–-]/).map(x => Number(x.trim()));
  expect(nums, `unparseable range: ${s}`).toHaveLength(2);
  expect(nums.every(n => Number.isFinite(n))).toBe(true);
  return [nums[0], nums[1]];
}

describe('REPORT_LENGTH_SPECS', () => {
  it('defines every preset with parseable, ascending ranges', () => {
    for (const k of KEYS) {
      const spec = REPORT_LENGTH_SPECS[k];
      for (const field of ['total', 'sectionWords', 'quick', 'sections'] as const) {
        const [lo, hi] = range(spec[field]);
        expect(lo, `${k}.${field} lower bound`).toBeGreaterThan(0);
        expect(hi, `${k}.${field} is not ascending`).toBeGreaterThan(lo);
      }
    }
  });

  it('keeps the per-section budget consistent with the stated total', () => {
    // sections x sectionWords, plus a capstone (exec overview + contradictions
    // + verdict, ~10-20% of the body), must be able to land in `total`.
    for (const k of KEYS) {
      const spec = REPORT_LENGTH_SPECS[k];
      const [minSec, maxSec] = range(spec.sections);
      const [minWords, maxWords] = range(spec.sectionWords);
      const [minTotal, maxTotal] = range(spec.total);

      // The smallest obedient report must not undershoot the floor by much…
      expect(minSec * minWords, `${k}: fewest/shortest sections fall far below total`)
        .toBeGreaterThan(minTotal * 0.5);
      // …and the largest must not blow the ceiling. This is the check that
      // 4-8 x 300-700 vs "1800-3000" would have failed: 5600 > 3000 x 1.25.
      expect(maxSec * maxWords, `${k}: most/longest sections overshoot the stated total`)
        .toBeLessThanOrEqual(maxTotal * 1.25);
    }
  });

  it('orders the three presets by length, so the dial means something', () => {
    const totals = KEYS.map(k => range(REPORT_LENGTH_SPECS[k].total));
    expect(totals[0][1]).toBeLessThanOrEqual(totals[1][0]);   // concise ends before standard starts
    expect(totals[1][1]).toBeLessThanOrEqual(totals[2][0]);   // standard ends before comprehensive starts
  });

  it('keeps standard centred near 2000 words — a side panel, not an essay', () => {
    const [lo, hi] = range(REPORT_LENGTH_SPECS.standard.total);
    const mid = (lo + hi) / 2;
    expect(mid).toBeGreaterThanOrEqual(1500);
    expect(mid).toBeLessThanOrEqual(2300);
  });
});
