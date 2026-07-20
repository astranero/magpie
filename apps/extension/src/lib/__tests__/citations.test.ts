import { describe, it, expect } from 'vitest';
import { stripCitations, buildCitationContext, CITATION_SYSTEM_PROMPT } from '../citations';
import type { Chunk } from '../db';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal Chunk fixture — only the fields used by buildCitationContext. */
function makeChunk(overrides: Partial<Chunk> & { docId: string; anchorId: string; text: string }): Chunk {
  return {
    id: 'test-id',
    chunkIndex: 0,
    heading: '',
    sectionPath: 'Document',
    paragraphIndex: 0,
    charStart: 0,
    charEnd: overrides.text.length,
    ...overrides,
  };
}

// ─── stripCitations — existing tests ─────────────────────────────────────────

describe('citations', () => {
  it('should strip citation markers', () => {
    const text = 'This is a claim [d1.s1.p1]. Another claim [d1.s2.p2].';
    expect(stripCitations(text)).toBe('This is a claim. Another claim.');
  });

  it('should ignore malformed markers', () => {
    const text = 'This is [not-a-citation] and [d1.s0].';
    expect(stripCitations(text)).toBe('This is [not-a-citation] and [d1.s0].');
  });

  it('should handle complex marker formatting', () => {
    const text = 'Sentence [d1.s1.p1.0] continued.';
    expect(stripCitations(text)).toBe('Sentence continued.');
  });
});

// ─── stripCitations — extended coverage ──────────────────────────────────────

describe('stripCitations — extended', () => {
  it('strips multiple adjacent citations leaving no gap before the period', () => {
    const text = 'claim [d1.s0.p0][d2.s1.p1].';
    expect(stripCitations(text)).toBe('claim.');
  });

  it('strips a citation at the very start of a sentence', () => {
    const text = '[d1.s0.p0] introduces the concept.';
    expect(stripCitations(text)).toBe('introduces the concept.');
  });

  it('strips a citation with no surrounding spaces', () => {
    // Marker sits between two words without spaces — both words remain adjacent
    const text = 'abc[d1.s0.p0]def';
    expect(stripCitations(text)).toBe('abcdef');
  });

  it('leaves text unchanged when there are no citation markers', () => {
    const text = 'Plain text with no citations at all.';
    expect(stripCitations(text)).toBe(text);
  });

  it('does not strip an anchor whose doc-part exceeds 9 characters total', () => {
    // CITATION_REGEX allows [a-z]\w{1,8} = 2–9 chars total for the doc id part
    // 'd' + 9 chars = 10 chars total → exceeds the limit → not matched
    const text = 'Some claim [dverylongi.s0.p0] here.';
    expect(stripCitations(text)).toBe('Some claim [dverylongi.s0.p0] here.');
  });

  it('strips an anchor whose doc-part is exactly 9 characters total (max valid)', () => {
    // 'd' + 8 chars = 9 total → matches \w{1,8} exactly
    const text = 'Some claim [dverylong.s0.p0] here.';
    expect(stripCitations(text)).toBe('Some claim here.');
  });

  it('strips sub-chunk anchors with four-part format (docId.sN.pN.subIdx)', () => {
    const text = 'Fact [d1.s0.p1.2].';
    expect(stripCitations(text)).toBe('Fact.');
  });
});

// ─── buildCitationContext ─────────────────────────────────────────────────────

describe('buildCitationContext', () => {
  it('renders a [Source:] header and <c> anchor tag for a single chunk', () => {
    const chunks = [makeChunk({ docId: 'd1', anchorId: 'd1.s0.p0', text: 'Hello world.' })];
    const titles = new Map([['d1', 'Doc A']]);
    const ctx = buildCitationContext(chunks, titles);

    expect(ctx).toContain('[Source: Doc A]');
    expect(ctx).toContain('<c>d1.s0.p0</c>');
    expect(ctx).toContain('Hello world.');
  });

  it('emits only one [Source:] header for multiple chunks from the same document', () => {
    const chunks = [
      makeChunk({ docId: 'd1', anchorId: 'd1.s0.p0', text: 'First chunk.', chunkIndex: 0 }),
      makeChunk({ docId: 'd1', anchorId: 'd1.s0.p1', text: 'Second chunk.', chunkIndex: 1 }),
    ];
    const ctx = buildCitationContext(chunks, new Map([['d1', 'Doc A']]));
    const headerCount = (ctx.match(/\[Source:/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('emits separate [Source:] headers for each distinct document in order', () => {
    const chunks = [
      makeChunk({ docId: 'd1', anchorId: 'd1.s0.p0', text: 'From doc 1.' }),
      makeChunk({ docId: 'd2', anchorId: 'd2.s0.p0', text: 'From doc 2.' }),
    ];
    const ctx = buildCitationContext(chunks, new Map([['d1', 'Doc A'], ['d2', 'Doc B']]));
    const headerCount = (ctx.match(/\[Source:/g) ?? []).length;
    expect(headerCount).toBe(2);
    expect(ctx.indexOf('[Source: Doc A]')).toBeLessThan(ctx.indexOf('[Source: Doc B]'));
  });

  it('falls back to "Unknown" for a docId not present in the titles map', () => {
    const chunks = [makeChunk({ docId: 'mystery', anchorId: 'mystery.s0.p0', text: 'Text.' })];
    const ctx = buildCitationContext(chunks, new Map());
    expect(ctx).toContain('[Source: Unknown]');
  });

  it('stops adding chunks once maxChars is exceeded', () => {
    // 10 chunks, each with 20-char text; maxChars=50 means only the first 1-2 should appear
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk({ docId: 'd1', anchorId: `d1.s0.p${i}`, text: 'x'.repeat(20), chunkIndex: i })
    );
    const ctx = buildCitationContext(chunks, new Map([['d1', 'D']]), 50);
    const anchorsRendered = (ctx.match(/<c>/g) ?? []).length;
    expect(anchorsRendered).toBeGreaterThan(0);
    expect(anchorsRendered).toBeLessThan(10);
  });

  it('returns an empty string for an empty chunk list', () => {
    expect(buildCitationContext([], new Map())).toBe('');
  });
});

// ─── CITATION_SYSTEM_PROMPT contract ─────────────────────────────────────────

describe('CITATION_SYSTEM_PROMPT', () => {
  it('instructs the model to answer only from provided sources', () => {
    expect(CITATION_SYSTEM_PROMPT).toContain('ONLY using the provided source documents');
  });

  it('shows a concrete anchor ID example so the model knows the format', () => {
    expect(CITATION_SYSTEM_PROMPT).toContain('d3ab01.s1.p2');
  });

  it('tells the model never to fabricate citations', () => {
    expect(CITATION_SYSTEM_PROMPT.toLowerCase()).toContain('never fabricate');
  });

  it('instructs the model to admit when information is not in sources', () => {
    // Language-independent sentinel (the refusal net works in any language).
    expect(CITATION_SYSTEM_PROMPT).toContain('NO_SOURCES_IN_WORKSPACE');
  });
});
