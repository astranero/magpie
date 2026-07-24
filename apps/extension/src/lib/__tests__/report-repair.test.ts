import { describe, it, expect } from 'vitest';
import { splitCapstone, trimTruncatedTail, stripUnresolvableAnchors } from '../report-repair';

describe('splitCapstone', () => {
  it('splits on the exact delimiters', () => {
    const parts = splitCapstone('Overview text.\n---CONTRADICTIONS---\nSources disagree.\n---VERDICT---\nGo ahead.');
    expect(parts.exec).toBe('Overview text.');
    expect(parts.contradictions).toBe('Sources disagree.');
    expect(parts.verdict).toBe('Go ahead.');
  });

  it('survives the PARAPHRASED delimiter that shipped a broken report', () => {
    // Live failure: the model echoed the section's full name, the exact-match
    // split found nothing, and the whole capstone became the executive
    // overview — raw fence lines and all — with no Verdict at the bottom.
    const raw = [
      'Overview text.',
      '---CONTRADICTIONS & OPEN QUESTIONS---',
      'The material does not settle this.',
      '---VERDICT---',
      'The strongest case supports X.',
    ].join('\n');
    const parts = splitCapstone(raw);
    expect(parts.exec).toBe('Overview text.');
    expect(parts.contradictions).toBe('The material does not settle this.');
    expect(parts.verdict).toBe('The strongest case supports X.');
  });

  it('accepts plain headings instead of fences', () => {
    const parts = splitCapstone('Overview.\n\n## Contradictions & Open Questions\nDisagreement.\n\n## Verdict\nProceed.');
    expect(parts.exec).toBe('Overview.');
    expect(parts.contradictions).toBe('Disagreement.');
    expect(parts.verdict).toBe('Proceed.');
  });

  it('treats Recommendation as the verdict block', () => {
    // The prompt offers "Verdict (or Recommendation)"; both must land correctly.
    const parts = splitCapstone('Overview.\n---RECOMMENDATION---\nAdopt it.');
    expect(parts.verdict).toBe('Adopt it.');
  });

  it('never lets an unrecognised fence line reach the reader', () => {
    const parts = splitCapstone('Overview.\n---SOMETHING ELSE---\nMore overview.');
    expect(parts.exec).not.toMatch(/---/);
    expect(parts.exec).toContain('More overview.');
  });

  it('puts everything in exec when the model emitted no structure at all', () => {
    const parts = splitCapstone('Just one paragraph.');
    expect(parts.exec).toBe('Just one paragraph.');
    expect(parts.contradictions).toBe('');
    expect(parts.verdict).toBe('');
  });

  it('handles empty input', () => {
    expect(splitCapstone('')).toEqual({ exec: '', contradictions: '', verdict: '' });
  });
});

describe('trimTruncatedTail', () => {
  it('drops a table header that never got its delimiter row', () => {
    // The live break: generation stopped here, and a lone header renders as a
    // stray line of pipes.
    const text = 'Body paragraph.\n\n| Feature Area | User Perception/Behavioral Correlate';
    expect(trimTruncatedTail(text)).toBe('Body paragraph.');
  });

  it('drops a table that has only a header and a delimiter', () => {
    const text = 'Body.\n\n| A | B |\n| --- | --- |';
    expect(trimTruncatedTail(text)).toBe('Body.');
  });

  it('KEEPS a complete table', () => {
    const text = 'Body.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    expect(trimTruncatedTail(text)).toBe(text);
  });

  it('drops a heading with nothing under it', () => {
    expect(trimTruncatedTail('Body.\n\n## Dangling Heading')).toBe('Body.');
  });

  it('drops a final line that breaks off mid-sentence', () => {
    const text = 'A finished paragraph here.\n\nThis sentence was cut off before it could reach its';
    expect(trimTruncatedTail(text)).toBe('A finished paragraph here.');
  });

  it('KEEPS a short trailing line — a label is not a truncation', () => {
    const text = 'Body.\n\nSee also';
    expect(trimTruncatedTail(text)).toBe(text);
  });

  it('KEEPS a list item that legitimately lacks punctuation', () => {
    const text = 'Body.\n\n- one thing worth noting about the subject at hand';
    expect(trimTruncatedTail(text)).toBe(text);
  });

  it('KEEPS ordinary prose that ends properly', () => {
    const text = 'The finding holds across every source examined [d1.s0.p0].';
    expect(trimTruncatedTail(text)).toBe(text);
  });

  it('unwinds several layers of debris but stops there', () => {
    const text = 'Real content.\n\n## Heading\n\n| A | B';
    expect(trimTruncatedTail(text)).toBe('Real content.');
  });

  it('handles empty input', () => {
    expect(trimTruncatedTail('')).toBe('');
  });
});

describe('stripUnresolvableAnchors', () => {
  it('removes the bare doc-id anchor that shipped in a live report', () => {
    // `[d7c0864]` has no .sN.pM, so it cannot address a chunk under any
    // circumstances — it rendered as literal noise.
    const text = 'Rich context and validation are key enablers [d7c0864].';
    expect(stripUnresolvableAnchors(text)).toBe('Rich context and validation are key enablers.');
  });

  it('KEEPS a well-formed anchor even when unresolved', () => {
    // linkify leaves these deliberately: the renderer resolves them against the
    // chunk store at display time and may find them.
    const text = 'A claim [d3ab01.s1.p2].';
    expect(stripUnresolvableAnchors(text)).toBe(text);
  });

  it('KEEPS already-linkified citations', () => {
    const text = 'A claim [[1](#cite:d3ab01.s1.p2)].';
    expect(stripUnresolvableAnchors(text)).toBe(text);
  });

  it('does not touch ordinary brackets', () => {
    const text = 'See [note], item [1], and source [W3].';
    expect(stripUnresolvableAnchors(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(stripUnresolvableAnchors('')).toBe('');
  });
});
