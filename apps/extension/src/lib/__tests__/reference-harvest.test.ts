import { describe, it, expect } from 'vitest';
import { harvestReferences, partitionRefs } from '../reference-harvest';

describe('harvestReferences', () => {
  it('extracts arxiv URLs and bare arxiv IDs', () => {
    const refs = harvestReferences(['See arxiv.org/abs/2401.12345 and also 2312.00752 for detail']);
    const urls = refs.map(r => r.url);
    expect(urls).toContain('https://arxiv.org/abs/2401.12345');
    expect(urls).toContain('https://arxiv.org/abs/2312.00752');
    expect(refs.every(r => r.kind === 'arxiv')).toBe(true);
  });
  it('extracts DOIs and trims trailing punctuation', () => {
    const refs = harvestReferences(['cited as 10.1145/3583133.3596373.']);
    expect(refs[0].url).toBe('https://doi.org/10.1145/3583133.3596373');
    expect(refs[0].kind).toBe('doi');
  });
  it('extracts markdown web links with anchor text, skips url-as-anchor', () => {
    const refs = harvestReferences(['[WebGPU spec](https://gpuweb.github.io/gpuweb/) and [https://x.com](https://x.com)']);
    const web = refs.filter(r => r.kind === 'web');
    expect(web).toHaveLength(1);
    expect(web[0].anchorText).toBe('WebGPU spec');
  });
  it('excludes seen and junk URLs', () => {
    const refs = harvestReferences(['arxiv.org/abs/2401.12345 [Home](https://site.com/nav.css)'], {
      seenUrls: new Set(['https://arxiv.org/abs/2401.12345']),
      isJunk: (u) => u.endsWith('.css'),
    });
    expect(refs).toHaveLength(0);
  });
  it('dedupes and caps at max', () => {
    const text = Array.from({ length: 40 }, (_, i) => `arxiv.org/abs/2401.${10000 + i}`).join(' ');
    expect(harvestReferences([text], { max: 10 })).toHaveLength(10);
  });
});

describe('partitionRefs', () => {
  it('splits citation-grade from web', () => {
    const { citations, web } = partitionRefs([
      { url: 'https://arxiv.org/abs/1', kind: 'arxiv' },
      { url: 'https://doi.org/10.1/x', kind: 'doi' },
      { url: 'https://blog.com/p', kind: 'web', anchorText: 'Post' },
    ]);
    expect(citations).toHaveLength(2);
    expect(web).toHaveLength(1);
  });
});
