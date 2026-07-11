import { describe, it, expect, vi } from 'vitest';

// ── Mock all modules that deep-researcher imports so the test environment
//    (Node, no Chrome APIs, no IndexedDB) stays clean.
//    The four functions under test are all pure — they never call these imports.
vi.mock('../lib/db', () => ({
  saveDocument: vi.fn(),
  linkDocumentToProject: vi.fn(),
  saveChunksOnly: vi.fn(),
}));
vi.mock('../lib/vector-store', () => ({
  addChunksToVectorStore: vi.fn(),
  searchSessionChunks: vi.fn(),
  resetSessionIndex: vi.fn(),
}));
vi.mock('../lib/research-store', () => ({
  getJob: vi.fn().mockResolvedValue(null),
  updateJob: vi.fn(),
  getPage: vi.fn().mockResolvedValue(null),
  savePage: vi.fn(),
  listPages: vi.fn().mockResolvedValue([]),
}));

import {
  buildAnchoredContext,
  extractSearchUrls,
  generateSearchQueries,
  generateSubQuestions,
} from '../deep-researcher';

// ─── buildAnchoredContext ─────────────────────────────────────────────────────

describe('buildAnchoredContext', () => {
  it('renders [Source:] from the title map and wraps anchor in <c> tags', () => {
    const chunks = [{ docId: 'd1', anchorId: 'd1.s0.p0', heading: 'Intro', text: 'Body text.' }];
    const ctx = buildAnchoredContext(chunks, new Map([['d1', 'My Paper']]));

    expect(ctx).toContain('[Source: My Paper]');
    expect(ctx).toContain('<c>d1.s0.p0</c>');
    expect(ctx).toContain('Body text.');
  });

  it('includes the heading on its own line when the heading is non-empty', () => {
    const chunks = [{ docId: 'd1', anchorId: 'd1.s0.p0', heading: 'Introduction', text: 'Body.' }];
    const ctx = buildAnchoredContext(chunks, new Map([['d1', 'Doc']]));
    // heading appears followed immediately by a newline, before the body text
    expect(ctx).toContain('Introduction\n');
    expect(ctx.indexOf('Introduction')).toBeLessThan(ctx.indexOf('Body.'));
  });

  it('omits a heading line when heading is an empty string', () => {
    const chunks = [{ docId: 'd1', anchorId: 'd1.s0.p0', heading: '', text: 'Body text.' }];
    const ctx = buildAnchoredContext(chunks, new Map([['d1', 'Doc']]));
    // The anchor tag is directly followed by a space and then the text — no heading line
    expect(ctx).toContain('<c>d1.s0.p0</c> Body text.');
  });

  it('falls back to the docId as the source label when no title map is supplied', () => {
    const chunks = [{ docId: 'xyz123', anchorId: 'xyz123.s0.p0', heading: '', text: 'Text.' }];
    const ctx = buildAnchoredContext(chunks);
    expect(ctx).toContain('[Source: xyz123]');
  });

  it('emits only one [Source:] header for multiple chunks from the same document', () => {
    const chunks = [
      { docId: 'd1', anchorId: 'd1.s0.p0', heading: '', text: 'First.' },
      { docId: 'd1', anchorId: 'd1.s0.p1', heading: '', text: 'Second.' },
    ];
    const ctx = buildAnchoredContext(chunks, new Map([['d1', 'Doc']]));
    expect((ctx.match(/\[Source:/g) ?? []).length).toBe(1);
  });

  it('emits separate [Source:] headers as docs change, in document order', () => {
    const chunks = [
      { docId: 'd1', anchorId: 'd1.s0.p0', heading: '', text: 'From A.' },
      { docId: 'd2', anchorId: 'd2.s0.p0', heading: '', text: 'From B.' },
    ];
    const ctx = buildAnchoredContext(chunks, new Map([['d1', 'Doc A'], ['d2', 'Doc B']]));
    expect((ctx.match(/\[Source:/g) ?? []).length).toBe(2);
    expect(ctx.indexOf('[Source: Doc A]')).toBeLessThan(ctx.indexOf('[Source: Doc B]'));
  });

  it('returns an empty string for an empty chunk array', () => {
    expect(buildAnchoredContext([])).toBe('');
    expect(buildAnchoredContext([], new Map())).toBe('');
  });
});

// ─── extractSearchUrls ────────────────────────────────────────────────────────

describe('extractSearchUrls', () => {
  it('decodes and extracts URLs from DDG uddg= redirect parameters', () => {
    const html = 'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&rut=xyz"';
    const urls = extractSearchUrls(html);
    expect(urls.has('https://example.com/article')).toBe(true);
  });

  it('filters out blocked domains (youtube, google, social media) from DDG results', () => {
    const html = [
      'uddg=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc',
      'uddg=https%3A%2F%2Fgoogle.com%2Fsearch',
      'uddg=https%3A%2F%2Ffacebook.com%2Fpost',
      'uddg=https%3A%2F%2Ftwitter.com%2Fuser',
    ].join(' ');
    const urls = extractSearchUrls(html);
    expect(urls.size).toBe(0);
  });

  it('falls back to plain https link extraction when no uddg= params are present (Jina markdown)', () => {
    const markdown = 'Read more at https://arxiv.org/abs/2401.12345 and https://nature.com/article/123';
    const urls = extractSearchUrls(markdown);
    expect(urls.has('https://arxiv.org/abs/2401.12345')).toBe(true);
    expect(urls.has('https://nature.com/article/123')).toBe(true);
  });

  it('filters out jina.ai self-links from the fallback plain-link path', () => {
    const markdown = 'Processed by https://r.jina.ai/https://example.com — see also https://example.org/page';
    const urls = extractSearchUrls(markdown);
    expect([...urls].some(u => u.includes('jina.ai'))).toBe(false);
    expect(urls.has('https://example.org/page')).toBe(true);
  });

  it('caps the result set at 12 URLs even when more are present', () => {
    const params = Array.from({ length: 20 }, (_, i) =>
      `uddg=https%3A%2F%2Fsite${i}.example.com%2F`
    ).join(' ');
    const urls = extractSearchUrls(params);
    expect(urls.size).toBe(12);
  });

  it('silently skips malformed percent-encoded sequences without throwing', () => {
    const bad = 'uddg=%ZZmalformed uddg=https%3A%2F%2Fgood.org%2F';
    let urls: Set<string>;
    expect(() => { urls = extractSearchUrls(bad); }).not.toThrow();
    // The valid URL should still be captured
    expect(urls!.has('https://good.org/')).toBe(true);
  });

  it('strips trailing punctuation (., ;) from plain fallback URLs', () => {
    const text = 'Visit https://example.com/article. Or https://example.org/page, for more.';
    const urls = extractSearchUrls(text);
    expect([...urls].some(u => u.endsWith('.'))).toBe(false);
    expect([...urls].some(u => u.endsWith(','))).toBe(false);
    expect(urls.has('https://example.com/article')).toBe(true);
  });
});

// ─── generateSearchQueries ────────────────────────────────────────────────────

describe('generateSearchQueries', () => {
  it('returns the parsed JSON array from a well-formed LLM response', async () => {
    const llm = vi.fn().mockResolvedValue('["query one", "query two", "query three"]');
    const result = await generateSearchQueries('AI safety', llm);
    expect(result).toEqual(['query one', 'query two', 'query three']);
  });

  it('extracts the JSON array even when the LLM wraps it in prose', async () => {
    const llm = vi.fn().mockResolvedValue('Here are my queries:\n["q1","q2"]\nDone.');
    const result = await generateSearchQueries('topic', llm);
    expect(result).toEqual(['q1', 'q2']);
  });

  it('slices the result to a maximum of 7 entries', async () => {
    const tenQueries = JSON.stringify(Array.from({ length: 10 }, (_, i) => `q${i}`));
    const llm = vi.fn().mockResolvedValue(tenQueries);
    const result = await generateSearchQueries('topic', llm);
    expect(result.length).toBe(7);
  });

  it('falls back to [topic] when the LLM returns unparseable content', async () => {
    const llm = vi.fn().mockResolvedValue('Sorry, I cannot help with that.');
    const result = await generateSearchQueries('my topic', llm);
    expect(result).toEqual(['my topic']);
  });

  it('passes the topic as the user message to the LLM', async () => {
    const llm = vi.fn().mockResolvedValue('["q1"]');
    await generateSearchQueries('neural networks', llm);
    expect(llm).toHaveBeenCalledOnce();
    const [, userMsg] = llm.mock.calls[0];
    expect(userMsg).toBe('neural networks');
  });
});

// ─── generateSubQuestions ─────────────────────────────────────────────────────

describe('generateSubQuestions', () => {
  it('returns the parsed JSON array from a well-formed LLM response', async () => {
    const llm = vi.fn().mockResolvedValue('["What is X?", "How does X work?", "What are the limits of X?"]');
    const result = await generateSubQuestions('topic X', llm);
    expect(result).toEqual(['What is X?', 'How does X work?', 'What are the limits of X?']);
  });

  it('falls back to [topic] when the LLM returns an empty array (unlike generateSearchQueries)', async () => {
    // generateSubQuestions checks length > 0 before accepting the array
    const llm = vi.fn().mockResolvedValue('[]');
    const result = await generateSubQuestions('my topic', llm);
    expect(result).toEqual(['my topic']);
  });

  it('falls back to [topic] when the LLM returns unparseable content', async () => {
    const llm = vi.fn().mockResolvedValue('not valid json');
    const result = await generateSubQuestions('my topic', llm);
    expect(result).toEqual(['my topic']);
  });

  it('slices the result to a maximum of 7 sub-questions', async () => {
    const nine = JSON.stringify(Array.from({ length: 9 }, (_, i) => `Q${i}?`));
    const llm = vi.fn().mockResolvedValue(nine);
    const result = await generateSubQuestions('topic', llm);
    expect(result.length).toBe(7);
  });
});
