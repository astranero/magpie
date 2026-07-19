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
  sourceTier,
  dedupeSourceRecords,
  buildSourcesDocMarkdown,
  formatEvaluationBlock,
  buildCleanedPdfDoc,
  linkifyReportCitations,
  isJunkUrl,
  weightedEvalScore,
  normalizeSection,
  stripLeadingTitle,
  stripStageBriefPseudoCitations,
  reflectOnStage,
  planStageAgents,
  SourceRecord,
} from '../deep-researcher';

describe('linkifyReportCitations', () => {
  // makeDocShortId = 'd' + fullId.slice(0,6), so docId '9b96b9…' → anchor short 'd9b96b9'
  const rec = (docId: string, url: string, title: string): SourceRecord =>
    ({ docId, url, title, label: 'WEB', tier: 'standard' });

  it('rewrites inline anchors to numbered markdown links', () => {
    const records = [rec('9b96b9AA', 'https://ex.com/a', 'Paper A')];
    const { text, cited } = linkifyReportCitations('Claim [d9b96b9.s1.p6].', records);
    expect(text).toBe('Claim [[1](https://ex.com/a)].');
    expect(cited).toHaveLength(1);
  });

  it('reuses the same number for repeated anchors of one source', () => {
    const records = [rec('9b96b9AA', 'https://ex.com/a', 'A'), rec('412359BB', 'https://ex.com/b', 'B')];
    const { text, cited } = linkifyReportCitations('[d9b96b9.s1.p6] x [d412359.s2.p1] y [d9b96b9.s3.p0].', records);
    expect(text).toBe('[[1](https://ex.com/a)] x [[2](https://ex.com/b)] y [[1](https://ex.com/a)].');
    expect(cited.map(c => c.title)).toEqual(['A', 'B']);
  });

  it('escapes parens in URLs and leaves unknown anchors untouched', () => {
    const records = [rec('9b96b9AA', 'https://ex.com/a_(1)', 'A')];
    const { text } = linkifyReportCitations('[d9b96b9.s1.p6] and [dZZZZ99.s1.p1].', records);
    expect(text).toBe('[[1](https://ex.com/a_%281%29)] and [dZZZZ99.s1.p1].');
  });

  it('numbers plain [n] when the source has no URL', () => {
    const records = [rec('9b96b9AA', '', 'A')];
    const { text } = linkifyReportCitations('[d9b96b9.s1.p6].', records);
    expect(text).toBe('[1].');
  });
});

describe('generated report/doc content is pure markdown (no raw HTML tags)', () => {
  // The report + document renderers deliberately have no raw-HTML plugin
  // (reports embed scraped web text → XSS surface), so any <details>/<summary>
  // would show up as literal tags. These blocks must stay markdown.
  it('formatEvaluationBlock emits a markdown heading, not <details>', () => {
    const ev: any = {
      verdict: 'NEEDS_REVISION', score: 4, recommendation: 'Expand section 5.',
      strengths: ['Clear logistics.'], weaknesses: ['Thin on examples.'],
      flaggedSections: ['Section 5: Initiating Intimacy'],
    };
    const out = formatEvaluationBlock(ev, true);
    expect(out).not.toMatch(/<\/?details>|<\/?summary>/);
    expect(out).toContain('#### ⚠️ Quality audit: NEEDS_REVISION (4/10) — after one revision pass');
    expect(out).toContain('**Weaknesses:**');
  });

  it('buildCleanedPdfDoc emits a markdown heading, not <details>', () => {
    const out = buildCleanedPdfDoc('Clean body.', 'RAW extraction blob.');
    expect(out).not.toMatch(/<\/?details>|<\/?summary>/);
    expect(out).toContain('## Raw PDF extraction (reference only — not indexed)');
    expect(out).toContain('RAW extraction blob.');
  });
});

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

  it('drops asset/schema junk like a doctype DTD URL', () => {
    // DDG's own "<!DOCTYPE html PUBLIC ... http://www.w3.org/TR/html4/loose.dtd>"
    // leaked into results and got scraped. It must be filtered out.
    const markdown = 'Blah http://www.w3.org/TR/html4/loose.dtd and a real one https://example.com/article';
    const urls = extractSearchUrls(markdown);
    expect([...urls].some(u => u.includes('w3.org') || u.endsWith('.dtd'))).toBe(false);
    expect(urls.has('https://example.com/article')).toBe(true);
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

// ─── Source records ───────────────────────────────────────────────────────────

const rec = (over: Partial<SourceRecord>): SourceRecord => ({
  url: 'https://example.com/a',
  title: 'A',
  label: 'WEB',
  docId: 'doc-a',
  tier: 'standard',
  ...over,
});

describe('sourceTier', () => {
  it('marks high-quality domains as high', () => {
    expect(sourceTier('https://www.nature.com/articles/x')).toBe('high');
    expect(sourceTier('https://arstechnica.com/ai/2026/post')).toBe('high');
  });

  it('marks arXiv and DOI-bearing URLs as high', () => {
    expect(sourceTier('https://arxiv.org/abs/2401.12345')).toBe('high');
    expect(sourceTier('https://dl.acm.org/doi/10.1145/3583133.3596373')).toBe('high');
  });

  it('promotes any URL with ≥10 citations to high', () => {
    expect(sourceTier('https://random-blog.io/post', 10)).toBe('high');
    expect(sourceTier('https://random-blog.io/post', 9)).toBe('standard');
  });

  it('defaults to standard for unknown domains without citations', () => {
    expect(sourceTier('https://some-random-site.io/article')).toBe('standard');
  });
});

describe('dedupeSourceRecords', () => {
  it('dedupes by docId', () => {
    const out = dedupeSourceRecords([rec({}), rec({ url: 'https://example.com/mirror' })]);
    expect(out.length).toBe(1);
  });

  it('falls back to URL when docId is empty and drops keyless records', () => {
    const out = dedupeSourceRecords([
      rec({ docId: '', url: 'https://x.com/1' }),
      rec({ docId: '', url: 'https://x.com/1' }),
      rec({ docId: '', url: '' }),
    ]);
    expect(out.length).toBe(1);
  });

  it('keeps distinct sources', () => {
    const out = dedupeSourceRecords([rec({}), rec({ docId: 'doc-b', url: 'https://example.com/b' })]);
    expect(out.length).toBe(2);
  });
});

describe('buildSourcesDocMarkdown', () => {
  const records: SourceRecord[] = [
    rec({ docId: 'd1', url: 'https://arxiv.org/abs/2401.00001', title: 'Paper One', label: 'ACADEMIC', tier: 'high', citations: 42 }),
    rec({ docId: 'd2', url: 'https://example.com/blog', title: 'Blog Post', label: 'WEB', tier: 'standard' }),
    rec({ docId: 'd3', url: 'https://news.site/item', title: 'News Item', label: 'NEWS', tier: 'standard' }),
  ];

  it('groups sources into per-agent sections with counts', () => {
    const md = buildSourcesDocMarkdown('test topic', records);
    expect(md).toContain('## Academic (1)');
    expect(md).toContain('## Web (1)');
    expect(md).toContain('## News (1)');
    expect(md).not.toContain('## MCP');
  });

  it('renders markdown links, tiers, and citation counts in table rows', () => {
    const md = buildSourcesDocMarkdown('test topic', records);
    expect(md).toContain('[Paper One](https://arxiv.org/abs/2401.00001)');
    expect(md).toContain('★ high');
    expect(md).toContain('| 42 |');
    expect(md).toContain('| — |'); // no citation count → em dash
  });

  it('summarises totals and high-authority count in the intro', () => {
    const md = buildSourcesDocMarkdown('test topic', records);
    expect(md).toContain('3 source(s), 1 high-authority');
  });

  it('dedupes records and skips URL-less entries', () => {
    const md = buildSourcesDocMarkdown('t', [
      ...records,
      records[0],                     // duplicate docId
      rec({ docId: 'd4', url: '' }),  // no URL → excluded from the list
    ]);
    expect(md).toContain('3 source(s)');
  });
});

// ─── stripModelBibliography ───────────────────────────────────────────────────

describe('stripModelBibliography', () => {
  it('strips a hand-written bibliography of bare doc-ids (real-world case)', async () => {
    const { stripModelBibliography } = await import('../deep-researcher');
    const report = `Report body with a claim [d13d5d8.s1.p2].

## Bibliography

[d13d5d8] Betting market odds data, July 2026.
[d3d84f3] Statistical probability analysis, July 2026.
[d5e15ed] Expert match preview and analysis.`;
    const out = stripModelBibliography(report);
    expect(out).toContain('claim [d13d5d8.s1.p2]');
    expect(out).not.toContain('Bibliography');
    expect(out).not.toContain('Betting market odds data');
  });

  it('keeps a "Sources" heading followed by prose (not a citation list)', async () => {
    const { stripModelBibliography } = await import('../deep-researcher');
    const report = `Body text.

## Sources

The main sources of disagreement between the two camps are methodological.
Neither side disputes the underlying data.`;
    expect(stripModelBibliography(report)).toBe(report);
  });

  it('handles bulleted reference lists and bold headings', async () => {
    const { stripModelBibliography } = await import('../deep-researcher');
    const report = `Body.

**References**

- [1] First source description
- [2] Second source description`;
    const out = stripModelBibliography(report);
    expect(out.trim()).toBe('Body.');
  });

  it('is a no-op when there is no bibliography section', async () => {
    const { stripModelBibliography } = await import('../deep-researcher');
    const report = 'Just a normal report [a1b2c3d.s0.p1] with citations.';
    expect(stripModelBibliography(report)).toBe(report);
  });
});

describe('isJunkUrl — reader-proxy dead ends', () => {
  it('skips dead ends with no open-access recovery path', () => {
    for (const u of [
      'https://www.linkedin.com/pulse/performance-testing-abc',
      'https://static.licdn.com/aero-v1/sc/h/xyz',
      'https://www.researchgate.net/figure/Compute-requirements_fig4_391',
      'https://www.researchgate.net/profile/Some-Author',
      'https://www.aimodels.fyi/papers/arxiv/streaming-fast-slow',
    ]) {
      expect(isJunkUrl(u), u).toBe(true);
    }
  });

  it('does NOT junk-filter recoverable or readable hosts', () => {
    for (const u of [
      // Cloudflare publishers are recovered via DOI → OA PDF, not junk-skipped
      'https://dl.acm.org/doi/10.1145/3746059.3747721',
      'https://ieeexplore.ieee.org/document/10589417',
      // readable directly
      'https://arxiv.org/pdf/2507.22352',
      'https://www.tandfonline.com/doi/full/10.1080/0144929X.2026.2692099',
      'https://www.researchgate.net/publication/387223217_Optimizing_LLM_Latency',
      'https://www.nngroup.com/articles/generative-ui/',
    ]) {
      expect(isJunkUrl(u), u).toBe(false);
    }
  });
});

describe('weightedEvalScore', () => {
  it('computes the weighted sum over the five dimensions', () => {
    // 8*.20 + 6*.20 + 4*.25 + 10*.20 + 5*.15 = 1.6+1.2+1.0+2.0+0.75 = 6.55 → 7
    expect(weightedEvalScore({ coverage: 8, evidence: 6, depthPerSection: 4, epistemicHonesty: 10, structure: 5 })).toBe(7);
  });
  it('all-10s → 10, all-0s → 0', () => {
    expect(weightedEvalScore({ coverage: 10, evidence: 10, depthPerSection: 10, epistemicHonesty: 10, structure: 10 })).toBe(10);
    expect(weightedEvalScore({ coverage: 0, evidence: 0, depthPerSection: 0, epistemicHonesty: 0, structure: 0 })).toBe(0);
  });
  it('rejects missing, out-of-range, or non-numeric dimensions (falls back to model score)', () => {
    expect(weightedEvalScore(undefined)).toBeNull();
    expect(weightedEvalScore({ coverage: 8 })).toBeNull();
    expect(weightedEvalScore({ coverage: 11, evidence: 6, depthPerSection: 4, epistemicHonesty: 10, structure: 5 })).toBeNull();
    expect(weightedEvalScore({ coverage: '8', evidence: 6, depthPerSection: 4, epistemicHonesty: 10, structure: 5 })).toBeNull();
  });
  it('depth is the heaviest dimension — zeroing it hurts more than zeroing structure', () => {
    const depthZeroed = weightedEvalScore({ coverage: 10, evidence: 10, depthPerSection: 0, epistemicHonesty: 10, structure: 10 })!;   // 7.5 → 8
    const structZeroed = weightedEvalScore({ coverage: 10, evidence: 10, depthPerSection: 10, epistemicHonesty: 10, structure: 0 })!;  // 8.5 → 9
    expect(structZeroed).toBeGreaterThan(depthZeroed);
  });
});

describe('stripLeadingTitle (sectioned-report hardening)', () => {
  it('still strips a leading H1 title', () => {
    expect(stripLeadingTitle('# Professional Report: Coffee\n\nBody text.')).toBe('Body text.');
  });
  it('strips a restated-title H2 ("Deep Research: …" / "Report on …")', () => {
    expect(stripLeadingTitle('## Deep Research: Coffee Health\n\nBody.')).toBe('Body.');
    expect(stripLeadingTitle('## Report on Coffee\n\nBody.')).toBe('Body.');
  });
  it('strips an H2 that heavily overlaps the topic (restated title)', () => {
    const out = stripLeadingTitle('## Health Effects of Coffee Consumption\n\nBody.', 'health effects of coffee consumption on adults');
    expect(out).toBe('Body.');
  });
  it('KEEPS a real section heading (the sectioned-report opener)', () => {
    const src = '## Demand and Pain Points\n\nUsers report…';
    expect(stripLeadingTitle(src, 'weaknesses of AI chat interfaces')).toBe(src);
  });
});

describe('normalizeSection', () => {
  const long = 'Analytical prose about the finding. '.repeat(10);
  it('prepends the canonical heading when missing', () => {
    expect(normalizeSection(long, 'My Section')!.startsWith('## My Section\n\n')).toBe(true);
  });
  it('replaces a divergent leading heading with the canonical one', () => {
    const out = normalizeSection(`## Some Other Title\n\n${long}`, 'My Section')!;
    expect(out.startsWith('## My Section\n\n')).toBe(true);
    expect(out).not.toContain('Some Other Title');
  });
  it('strips a stray H1 and rejects near-empty output', () => {
    expect(normalizeSection(`# Report\n\n${long}`, 'S')).not.toContain('# Report\n');
    expect(normalizeSection('too short', 'S')).toBeNull();
  });
});

describe('reflectOnStage', () => {
  const subQs = ['Q1', 'Q2'];
  const reflectJson = JSON.stringify({
    outline: { sections: [
      { id: 's1', heading: 'Alpha', goal: 'g', keyTerms: ['alpha'], evidenceNotes: ['n [d1.s1.p1]'], status: 'adequate' },
      { id: 's2', heading: 'Beta', goal: 'g', keyTerms: [], evidenceNotes: [], status: 'thin' },
      { id: 's3', heading: 'Gamma', goal: 'g', keyTerms: [], evidenceNotes: [], status: 'empty' },
    ] },
    handoff: { establishedFacts: ['f [d1.s1.p1]'], openGaps: ['g1'], contradictions: [], focusNext: 'beta' },
    queries: ['beta failure modes', 'gamma empirical studies', 'alpha independent replication'],
  });

  it('parses a good reflect and returns outline + handoff + queries', async () => {
    const llm = vi.fn().mockResolvedValue(reflectJson);
    const r = await reflectOnStage(2, 8, 'topic', subQs, 'brief text', null, llm);
    expect(r!.outline.sections).toHaveLength(3);
    expect(r!.outline.version).toBe(2);
    expect(r!.queries).toHaveLength(3);
  });

  it('tops up queries from thin sections when the model under-delivers', async () => {
    const under = JSON.parse(reflectJson); under.queries = ['only one query'];
    const llm = vi.fn().mockResolvedValue(JSON.stringify(under));
    const r = await reflectOnStage(2, 8, 'mytopic', subQs, 'brief', null, llm);
    expect(r!.queries.length).toBeGreaterThanOrEqual(3);
    expect(r!.queries.some(q => q.includes('mytopic'))).toBe(true);
  });

  it('returns null on garbage (caller falls back to old pipeline behavior)', async () => {
    const llm = vi.fn().mockResolvedValue('no json here at all');
    expect(await reflectOnStage(1, 8, 't', subQs, 'brief', null, llm)).toBeNull();
  });

  it('final stage: keeps empty queries empty (no top-up)', async () => {
    const fin = JSON.parse(reflectJson); fin.queries = [];
    const llm = vi.fn().mockResolvedValue(JSON.stringify(fin));
    const r = await reflectOnStage(8, 8, 't', subQs, 'brief', null, llm);
    expect(r!.queries).toEqual([]);
  });
});

describe('planStageAgents (source-mode agent routing)', () => {
  it('auto: web every stage; academic/news/MCP on stage 1 only', () => {
    expect(planStageAgents(1, 'auto', true)).toEqual({ web: true, academic: true, news: true, mcp: true });
    expect(planStageAgents(2, 'auto', true)).toEqual({ web: true, academic: false, news: false, mcp: false });
    expect(planStageAgents(8, 'auto', true)).toEqual({ web: true, academic: false, news: false, mcp: false });
  });

  it('auto: academic gated on the topic being scholarly', () => {
    expect(planStageAgents(1, 'auto', false).academic).toBe(false);
    expect(planStageAgents(1, 'auto', false).web).toBe(true);
  });

  it('academic: academic agent EVERY stage, nothing else — regardless of the topic gate', () => {
    for (const stage of [1, 2, 5, 8]) {
      expect(planStageAgents(stage, 'academic', false)).toEqual({ web: false, academic: true, news: false, mcp: false });
    }
  });
});

describe('stripStageBriefPseudoCitations', () => {
  it('removes invented [STAGE N BRIEF] markers, any casing, singular/plural', () => {
    const text = 'Smaller models have constrained capabilities [STAGE 4 BRIEF]. More susceptible [Stage 3 Brief][STAGE 5 BRIEF].';
    expect(stripStageBriefPseudoCitations(text))
      .toBe('Smaller models have constrained capabilities. More susceptible.');
  });
  it('leaves real anchors and ordinary brackets alone', () => {
    const text = 'Training cost $42 [d3ab01.s0.p1]. See [24] and the stage plan.';
    expect(stripStageBriefPseudoCitations(text)).toBe(text);
  });
});
