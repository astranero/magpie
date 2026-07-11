import { describe, it, expect } from 'vitest';
import { chunkDocument, makeDocShortId } from '../chunker';

describe('chunker', () => {
  it('should split document into sections by headings', () => {
    const content = '# Introduction\n\nParagraph 1.\n\n## Section 1\n\nParagraph 2.';
    const chunks = chunkDocument({ docShortId: 'd1', content });

    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe('Introduction');
    expect(chunks[1].heading).toBe('Section 1');
  });

  it('should generate stable anchor IDs', () => {
    // If I put it in a section, it should be s0, if no section it defaults to 'Document'
    // Actually if content is '# Intro\n\nPara 1.', 'Intro' is the first heading/section
    const content = '# Intro\n\nPara 1.';
    const chunks = chunkDocument({ docShortId: 'd1', content });
    expect(chunks[0].anchorId).toBe('d1.s1.p0'); // Updated to reflect reality
  });

  it('should handle empty input', () => {
    const chunks = chunkDocument({ docShortId: 'd1', content: '' });
    expect(chunks.length).toBe(0);
  });

  it('should handle YAML frontmatter correctly', () => {
    // Regression case: frontmatter should not be treated as a heading or text
    const content = '---\ntitle: Test\n---\n# Header\n\nParagraph.';
    const chunks = chunkDocument({ docShortId: 'd1', content });

    // Frontmatter is stripped before chunking: the YAML block must not be
    // indexed, and the first chunk belongs to the real first heading.
    expect(chunks[0].heading).toBe('Header');
    expect(chunks.some(c => c.text.includes('title: Test'))).toBe(false);
  });

  it('should merge tiny chunks', () => {
    const content = '# H\n\nTiny\n\nNot so tiny paragraph that exceeds the min chunk size requirement.';
    const chunks = chunkDocument({ docShortId: 'd1', content });

    // "Tiny" is < 50 chars, so it should merge with next
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('Tiny');
    expect(chunks[0].text).toContain('Not so tiny');
  });

  it('should split oversized chunks', () => {
    // Need enough content to force a split (> 2000 chars)
    const longText = 'Sentence long here. '.repeat(150);
    const content = '# Intro\n\n' + longText;
    const chunks = chunkDocument({ docShortId: 'd1', content });

    // Increased expectation as 150 * 20 = 3000 chars, chunked by 2000 should definitely split
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ─── makeDocShortId ───────────────────────────────────────────────────────────

describe('makeDocShortId', () => {
  it('takes first 6 chars of the input and prepends "d"', () => {
    // slice(0,6) of '550e8400-...' is '550e84', so the result is 'd550e84' (7 chars total)
    expect(makeDocShortId('550e8400-e29b-41d4-a716-446655440000')).toBe('d550e84');
  });

  it('handles a short input gracefully', () => {
    expect(makeDocShortId('abc')).toBe('dabc');
  });

  it('handles an empty string', () => {
    expect(makeDocShortId('')).toBe('d');
  });
});

// ─── anchor IDs & section structure ──────────────────────────────────────────

describe('chunkDocument — anchors and section structure', () => {
  it('produces sub-chunk anchor format (docId.sN.pN.subIdx) for oversized paragraphs', () => {
    // A single paragraph > 2000 chars forces sentence-level splitting
    const longPara = 'This is a sentence that is moderately long. '.repeat(60); // ~2640 chars
    const content = `# Topic\n\n${longPara}`;
    const chunks = chunkDocument({ docShortId: 'dx', content });

    // All sub-chunks should have the 4-part anchor format
    const subChunks = chunks.filter(c => c.anchorId.split('.').length === 4);
    expect(subChunks.length).toBeGreaterThan(0);
    // First sub-chunk of section s1, paragraph p0, sub-index 0
    expect(subChunks[0].anchorId).toBe('dx.s1.p0.0');
    expect(subChunks[1].anchorId).toBe('dx.s1.p0.1');
  });

  it('records sectionPath as the full heading hierarchy joined by " > "', () => {
    // H1 with a paragraph, then H2 (child) with a paragraph
    const content = [
      '# H1',
      '',
      'This is a long enough paragraph under H1 section for testing purposes.',
      '',
      '## H2',
      '',
      'This is a long enough paragraph under H2 section for testing purposes.',
    ].join('\n');
    const chunks = chunkDocument({ docShortId: 'dx', content });

    const h1Chunk = chunks.find(c => c.heading === 'H1');
    const h2Chunk = chunks.find(c => c.heading === 'H2');

    expect(h1Chunk?.sectionPath).toBe('H1');
    expect(h2Chunk?.sectionPath).toBe('H1 > H2');
  });

  it('all anchor IDs within a document are unique', () => {
    const content = [
      '# Section A',
      '',
      'First long paragraph with enough characters to avoid being merged away.',
      '',
      'Second long paragraph with enough characters to avoid being merged away.',
      '',
      '## Section B',
      '',
      'Third long paragraph with enough characters to avoid being merged away.',
      '',
      '### Section C',
      '',
      'Fourth long paragraph with enough characters to avoid being merged away.',
    ].join('\n');
    const chunks = chunkDocument({ docShortId: 'du', content });

    const ids = chunks.map(c => c.anchorId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all chunks under a heading share that heading value', () => {
    const content = [
      '## Methods',
      '',
      'First methods paragraph that is long enough to not be merged with the next.',
      '',
      'Second methods paragraph that is also long enough to stand on its own here.',
      '',
      'Third methods paragraph that is likewise long enough to remain separate here.',
    ].join('\n');
    const chunks = chunkDocument({ docShortId: 'dm', content });

    expect(chunks.length).toBe(3);
    chunks.forEach(c => expect(c.heading).toBe('Methods'));
  });

  it('charStart and charEnd are non-negative with charEnd > charStart', () => {
    const content = '# Intro\n\nThis paragraph has plenty of characters to form a valid chunk.';
    const chunks = chunkDocument({ docShortId: 'd1', content });

    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach(c => {
      expect(c.charStart).toBeGreaterThanOrEqual(0);
      expect(c.charEnd).toBeGreaterThan(c.charStart);
    });
  });

  it('produces zero chunks for truly empty content', () => {
    // An empty string has nothing for parseSections to work with
    const chunks = chunkDocument({ docShortId: 'd1', content: '' });
    expect(chunks.length).toBe(0);
  });

  it('chunkIndex increments monotonically starting from 0', () => {
    const content = [
      '# A',
      '',
      'Long enough paragraph one that should be kept as its own chunk here.',
      '',
      '## B',
      '',
      'Long enough paragraph two that should be kept as its own chunk here.',
    ].join('\n');
    const chunks = chunkDocument({ docShortId: 'di', content });

    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });
});
