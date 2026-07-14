import { describe, it, expect, vi } from 'vitest';
import {
  selectSemantic,
  parseRouterSelection,
  fetchWithinBudget,
  MAX_FILES,
  type LinkRef,
  type RerankFn,
} from '../context-retrieval';

// A rerank that scores by substring presence of any query word in the passage.
const substringRerank: RerankFn = async (q, passages) => {
  const words = q.toLowerCase().split(/\W+/).filter(Boolean);
  return passages.map(p => (words.some(w => p.toLowerCase().includes(w)) ? 0.9 : 0.1));
};
const nullRerank: RerankFn = async () => null;

describe('selectSemantic — files', () => {
  const paths = ['README.md', 'package.json', 'src/auth/session.ts', 'src/ui/button.tsx'];

  it('picks an explicitly named file (matchFilesInTree) without rerank', async () => {
    const rerank = vi.fn(substringRerank);
    const sel = await selectSemantic('what is in package.json?', paths, [], rerank);
    expect(sel.files).toContain('package.json');
    expect(rerank).not.toHaveBeenCalled();
  });

  it('falls back to reranking keyword-filtered paths for conceptual asks', async () => {
    // "auth" appears in a path but names no file token → semantic fallback.
    const sel = await selectSemantic('how does auth work here', paths, [], substringRerank);
    expect(sel.files).toContain('src/auth/session.ts');
  });

  it('loads nothing when no path carries the concept', async () => {
    const sel = await selectSemantic('what is the meaning of life', paths, [], substringRerank);
    expect(sel.files).toEqual([]);
  });

  it('never exceeds MAX_FILES', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `src/auth/mod${i}.ts`);
    const sel = await selectSemantic('auth', many, [], substringRerank);
    expect(sel.files.length).toBeLessThanOrEqual(MAX_FILES);
  });
});

describe('selectSemantic — links', () => {
  const links: LinkRef[] = [
    { url: 'https://x.com/pricing', anchorText: 'Pricing' },
    { url: 'https://x.com/docs', anchorText: 'Docs' },
    { url: 'https://x.com/blog', anchorText: 'Blog' },
  ];

  it('follows a keyword-matched link with no rerank round-trip', async () => {
    const rerank = vi.fn(nullRerank);
    const sel = await selectSemantic('how much is their pricing?', [], links, rerank);
    expect(sel.links.map(l => l.url)).toEqual(['https://x.com/pricing']);
    expect(rerank).not.toHaveBeenCalled();
  });

  it('follows via nav synonym (documentation → a "Docs" link), no rerank', async () => {
    const rerank = vi.fn(substringRerank);
    const sel = await selectSemantic('tell me about the documentation', [], links, rerank);
    expect(sel.links.map(l => l.url)).toContain('https://x.com/docs');
    expect(rerank).not.toHaveBeenCalled();
  });

  it('smart fallback: reranker picks the best link for a topical ask with no lexical hit', async () => {
    const docs: LinkRef[] = [
      { url: 'https://learn.ms/arm/overview', anchorText: 'ARM overview' },
      { url: 'https://learn.ms/azure/pipelines', anchorText: 'Azure Pipelines' },
      { url: 'https://learn.ms/arm/limits', anchorText: 'Resource group service quotas' },
    ];
    const sel = await selectSemantic('tell me about pipelines', [], docs, substringRerank);
    expect(sel.links.map(l => l.url)).toEqual(['https://learn.ms/azure/pipelines']);
  });

  it('smart fallback stays quiet when no link clears the confidence bar', async () => {
    // Nothing scores for "webhooks" → reranker returns low scores → follow none.
    const sel = await selectSemantic('does it support webhooks', [], links, substringRerank);
    expect(sel.links).toEqual([]);
  });

  it('is gated off for a page-summary / meta question (no rerank pollution)', async () => {
    const rerank = vi.fn(substringRerank);
    // "consensus of this page" is about the page itself — must not rerank-follow.
    const sel = await selectSemantic('what is the consensus of this page', [], links, rerank);
    expect(sel.links).toEqual([]);
    expect(rerank).not.toHaveBeenCalled();
  });
});

describe('parseRouterSelection', () => {
  const validFiles = ['a.ts', 'b.ts'];
  const links: LinkRef[] = [{ url: 'https://x/pricing', anchorText: 'Pricing' }];

  it('parses a clean JSON object', () => {
    const r = parseRouterSelection('{"files":["a.ts"],"links":["https://x/pricing"],"web":true}', validFiles, links);
    expect(r).toEqual({ files: ['a.ts'], links: [{ url: 'https://x/pricing', title: 'Pricing' }], web: true });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Sure!\n```json\n{ "files": ["b.ts"], "links": [], "web": false }\n```';
    const r = parseRouterSelection(raw, validFiles, links);
    expect(r?.files).toEqual(['b.ts']);
    expect(r?.web).toBe(false);
  });

  it('drops hallucinated paths/urls not in the catalog', () => {
    const r = parseRouterSelection('{"files":["nope.ts","a.ts"],"links":["https://evil/x"]}', validFiles, links);
    expect(r?.files).toEqual(['a.ts']);
    expect(r?.links).toEqual([]);
  });

  it('returns null on unparseable input (caller falls back to semantic)', () => {
    expect(parseRouterSelection('no json here', validFiles, links)).toBeNull();
    expect(parseRouterSelection('{ broken', validFiles, links)).toBeNull();
  });
});

describe('fetchWithinBudget', () => {
  it('keeps total under budget and drops overflow', async () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const { blocks } = await fetchWithinBudget(
      items,
      async (it) => ({ block: `b${it.n}`, chars: 60 }),
      { budget: 130 }, // fits two 60-char blocks, not three
    );
    expect(blocks).toEqual(['b1', 'b2']);
  });

  it('collects sources and degrades on per-item failure', async () => {
    const items = [{ url: 'a' }, { url: 'b' }];
    const { blocks, sources } = await fetchWithinBudget(
      items,
      async (it) => (it.url === 'a' ? null : { block: 'ok', chars: 5, source: { title: 'B', url: 'b' } }),
    );
    expect(blocks).toEqual(['ok']);
    expect(sources).toEqual([{ title: 'B', url: 'b' }]);
  });
});
