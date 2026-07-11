import { describe, it, expect } from 'vitest';
import { buildDocMeta, scoreDocsByMetadata, rrfFuse } from '../doc-meta-index';

const doc = (id: string, title: string, content: string, capturedAt = '2026-01-01T00:00:00Z') =>
  ({ id, title, content, capturedAt });

describe('buildDocMeta', () => {
  it('parses tags and type from frontmatter head', () => {
    const m = buildDocMeta(doc('d1', 'Paper', '---\ntype: pdf\ntags:\n  - transformers\n  - source/arxiv-org\n---\nBody'));
    expect(m.type).toBe('pdf');
    expect(m.tags).toContain('transformers');
    expect(m.tags).toContain('source/arxiv-org');
  });
  it('survives content without frontmatter', () => {
    const m = buildDocMeta(doc('d2', 'Plain', 'no frontmatter here'));
    expect(m.tags).toEqual([]);
    expect(m.type).toBe('');
  });
});

describe('scoreDocsByMetadata', () => {
  const metas = [
    buildDocMeta(doc('d1', 'Transformer architecture explained', '---\ntags:\n  - nlp\n---\n')),
    buildDocMeta(doc('d2', 'Cooking pasta', '---\ntags:\n  - food\n---\n')),
    buildDocMeta(doc('d3', 'Deep learning survey', '---\ntype: transformers\ntags:\n  - transformers\n---\n')),
  ];
  it('ranks title matches above tag/type matches', () => {
    const ranked = scoreDocsByMetadata('transformer', metas);
    expect(ranked[0].docId).toBe('d1'); // title match (weight 3)
  });
  it('matches on tags and type', () => {
    const ranked = scoreDocsByMetadata('transformers', metas).map(r => r.docId);
    expect(ranked).toContain('d3');
    expect(ranked).not.toContain('d2');
  });
  it('empty query and no-match return empty', () => {
    expect(scoreDocsByMetadata('', metas)).toEqual([]);
    expect(scoreDocsByMetadata('quantum biology', metas)).toEqual([]);
  });
  it('ignores stopwords', () => {
    expect(scoreDocsByMetadata('the a of', metas)).toEqual([]);
  });
});

describe('rrfFuse', () => {
  it('rewards consensus across lists', () => {
    const meta = ['a', 'b', 'c'];
    const content = ['b', 'a', 'd'];
    const fused = rrfFuse([meta, content]);
    expect(fused[0]).toBe('a'); // top-ish in both
    expect(fused).toContain('d');
  });
  it('single list preserves order', () => {
    expect(rrfFuse([['x', 'y', 'z']])).toEqual(['x', 'y', 'z']);
  });
});
