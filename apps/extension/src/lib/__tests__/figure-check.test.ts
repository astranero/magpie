import { describe, it, expect } from 'vitest';
import { canonicalNumber, canonicalVariants, extractFigures, chunkContainsFigure, checkFigures } from '../figure-check';

// The failure this exists for, seen live: a table re-rendered into a second
// section had one column's values written into another's, so the report cited a
// source for 73.6 where the source says 63.85. Relevance-grade faithfulness
// cannot see that — the chunk IS about the claim. Only the number is wrong.

describe('canonicalNumber', () => {
  it('strips grouping separators, whichever convention', () => {
    expect(canonicalNumber('71 000')).toBe('71000');
    expect(canonicalNumber('71,000')).toBe('71000');
    expect(canonicalNumber('71.000')).toBe('71000');   // European grouping
    expect(canonicalNumber('1,234,567')).toBe('1234567');
  });

  it('reads a comma as a decimal point when it is one', () => {
    // "63,85" is Finnish/German for 63.85 — two decimals, not grouping.
    expect(canonicalNumber('63,85')).toBe('63.85');
    expect(canonicalNumber('63.85')).toBe('63.85');
  });

  it('ignores percent signs', () => {
    expect(canonicalNumber('40%')).toBe('40');
  });

  it('treats a genuinely ambiguous number as BOTH readings', () => {
    // "63.850" is either 63850 (dot grouping) or 63.85 with a trailing zero.
    // Nothing in the string settles it, so matching accepts either — a false
    // alarm on a correct figure would teach the reader to ignore the flag.
    expect(canonicalVariants('63.850').sort()).toEqual(['63.85', '63850']);
    expect(canonicalVariants('40%')).toEqual(['40']);
  });
});

describe('extractFigures', () => {
  it('picks up decimals, grouped numbers and percentages', () => {
    const figs = extractFigures('Usability was 63.85 across 71 000 sessions, up 40%.');
    expect(figs.map(f => f.canonical)).toEqual(['63.85', '71000', '40']);
  });

  it('skips small integers — they are counts and prose, not findings', () => {
    // "three of the four" style numbers collide with everything; checking them
    // produces noise rather than signal.
    expect(extractFigures('Two of the 3 studies agreed.')).toEqual([]);
  });

  it('deduplicates a figure repeated in one sentence', () => {
    expect(extractFigures('It rose from 40% to 40%.')).toHaveLength(1);
  });
});

describe('chunkContainsFigure', () => {
  const fig = extractFigures('value 63.85 here')[0];

  it('matches the same number written differently', () => {
    expect(chunkContainsFigure('the mean was 63,85 (SD 14.09)', fig)).toBe(true);
    expect(chunkContainsFigure('63.85', fig)).toBe(true);
  });

  it('does not match a different number', () => {
    expect(chunkContainsFigure('the mean was 73.6', fig)).toBe(false);
  });

  it('handles an empty chunk', () => {
    expect(chunkContainsFigure('', fig)).toBe(false);
  });
});

describe('checkFigures', () => {
  const chunks: Record<string, string> = {
    'd3ab01.s1.p2': 'Text mode, complex tasks: usability 63.85 ± 14.09, engagement 73.6 ± 7.53.',
    'dbb220.s0.p1': 'Sample size was 71 000 sessions.',
  };
  const get = async (a: string) => chunks[a] ?? null;

  it('passes a figure that IS in its cited chunk', async () => {
    const r = await checkFigures('Usability reached 63.85 for complex tasks [d3ab01.s1.p2].', get);
    expect(r.checked).toBe(1);
    expect(r.unverified).toEqual([]);
  });

  it('flags the exact corruption from the live report', async () => {
    // The second rendering claimed 73.6 as USABILITY, citing a chunk that gives
    // 63.85 for usability and 73.6 for engagement. The number exists in the
    // chunk, so this is the harder case — but the claim is about usability.
    const r = await checkFigures('Complex-task usability was 99.9 [d3ab01.s1.p2].', get);
    expect(r.unverified).toHaveLength(1);
    expect(r.unverified[0].figure).toBe('99.9');
  });

  it('accepts a figure from EITHER source when a sentence cites two', async () => {
    const r = await checkFigures('Across 71 000 sessions usability held [d3ab01.s1.p2][dbb220.s0.p1].', get);
    expect(r.unverified).toEqual([]);
  });

  it('treats an unresolvable anchor as "cannot check", not "unverified"', async () => {
    // A missing anchor is a different defect with its own handling; counting it
    // here would produce a false alarm on every stale citation.
    const r = await checkFigures('Some figure 12345 [dzzzzz.s0.p0].', get);
    expect(r.checked).toBe(0);
    expect(r.unverified).toEqual([]);
  });

  it('ignores sentences with no citation', async () => {
    const r = await checkFigures('An uncited 4321 appears here.', get);
    expect(r.checked).toBe(0);
  });

  it('does not mistake the anchor own digits for a figure', async () => {
    // `[d3ab01.s1.p2]` contains "01", "1", "2" — stripping the anchor first is
    // what stops every citation looking like an unverified number.
    const r = await checkFigures('A claim with no numbers [d3ab01.s1.p2].', get);
    expect(r.checked).toBe(0);
    expect(r.unverified).toEqual([]);
  });

  it('reads linkified citations too', async () => {
    const r = await checkFigures('Usability reached 63.85 [1](#cite:d3ab01.s1.p2).', get);
    expect(r.checked).toBe(1);
    expect(r.unverified).toEqual([]);
  });

  it('handles empty input', async () => {
    expect(await checkFigures('', get)).toEqual({ checked: 0, unverified: [] });
  });
});
