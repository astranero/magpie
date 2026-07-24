import { describe, it, expect } from 'vitest';
import { splitFrontmatter, parseFrontmatterFields, buildFrontmatter } from '../frontmatter';

// Tests the REAL product helpers (lib/frontmatter.ts) used by DocumentView
// and the chunker. The previous version of this suite tested a locally
// declared regex — a tautology that could never catch a product bug.

describe('splitFrontmatter', () => {
  it('splits our own buildFrontmatter output round-trip', () => {
    const fm = buildFrontmatter({ title: 'Round: trip "test"', type: 'pdf', source: 'https://arxiv.org/abs/1', wordCount: 42 });
    const content = fm + '# Body\n\nText.';
    const { yaml, body } = splitFrontmatter(content);
    expect(yaml).not.toBeNull();
    expect(yaml).toContain('type: pdf');
    expect(body.trimStart().startsWith('# Body')).toBe(true);
    expect(body).not.toContain('word_count');
  });

  it('tolerates BOM and leading whitespace before the fence', () => {
    const { yaml, body } = splitFrontmatter('\uFEFF \n---\ntitle: x\n---\nBody');
    expect(yaml).toBe('title: x');
    expect(body).toBe('Body');
  });

  it('returns full content as body when no frontmatter', () => {
    const { yaml, body } = splitFrontmatter('Just text\n---\nnot frontmatter');
    expect(yaml).toBeNull();
    expect(body).toBe('Just text\n---\nnot frontmatter');
  });

  it('handles empty input', () => {
    expect(splitFrontmatter('')).toEqual({ yaml: null, body: '' });
  });
});

describe('parseFrontmatterFields', () => {
  it('parses key/values, strips quotes, humanizes underscores, collects tags', () => {
    const yaml = 'title: "A: tricky title"\ntype: pdf\nword_count: 8201\ntags:\n  - research-assistant\n  - source/arxiv-org';
    const { fields, tags } = parseFrontmatterFields(yaml);
    const map = new Map(fields);
    expect(map.get('title')).toBe('A: tricky title');
    expect(map.get('type')).toBe('pdf');
    expect(map.get('word count')).toBe('8201');
    expect(tags).toEqual(['research-assistant', 'source/arxiv-org']);
  });

  it('a non-indented line ends the tags list', () => {
    const yaml = 'tags:\n  - one\ncaptured: 2026-07-10\n  - stray';
    const { fields, tags } = parseFrontmatterFields(yaml);
    expect(tags).toEqual(['one']);
    expect(new Map(fields).get('captured')).toBe('2026-07-10');
  });

  it('skips empty values and garbage lines', () => {
    const { fields } = parseFrontmatterFields('author:\n%%%garbage\nsource: x');
    expect(fields).toEqual([['source', 'x']]);
  });
});

describe('shared coordinate space (DocumentView contract)', () => {
  it('body offsets differ from full-content offsets by exactly the fence length', () => {
    const fm = buildFrontmatter({ title: 'T', type: 'web-capture' });
    const content = fm + 'Hello world';
    const { body } = splitFrontmatter(content);
    expect(content.indexOf('world') - body.indexOf('world')).toBe(content.length - body.length);
    expect(body.indexOf('world')).toBeGreaterThanOrEqual(0);
  });
});
