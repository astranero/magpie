import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../chunker';
import { deduplicateParagraphs, cleanContent } from '../content-cleaner';
import { splitFrontmatter } from '../frontmatter';
import { checkContentQuality, looksLikeOcrGarbage, countWords } from '../quality-gate';
import { mergeOutlines, type ResearchOutline } from '../outline';
import { unicodeTokens, meaningfulTokens } from '../unicode-text';

// Regression tests for the P1 Unicode pass: every bug below silently broke
// non-English (esp. CJK) content before indexing/retrieval even ran.

describe('chunker — non-Latin paragraphs are not noise', () => {
  it('indexes a pure-Japanese paragraph', () => {
    const ja = 'これは人工知能に関する重要な研究段落です。機械学習モデルは大量のデータからパターンを学習します。'.repeat(2);
    const chunks = chunkDocument({ docShortId: 'dja0001', content: ja });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('indexes Arabic text', () => {
    const ar = 'هذا نص عربي طويل بما يكفي ليكون فقرة قابلة للفهرسة في النظام الخاص بنا هنا.'.repeat(3);
    const chunks = chunkDocument({ docShortId: 'dar0001', content: ar });
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('deduplicateParagraphs — non-ASCII paragraphs survive', () => {
  it('does not delete distinct Japanese paragraphs (ASCII \\w collision bug)', () => {
    const paras = Array.from({ length: 5 }, (_, i) =>
      `第${i + 1}段落の内容は一意であり、他の段落とは異なる情報を含んでいます。`);
    const out = deduplicateParagraphs(paras.join('\n\n'));
    for (let i = 0; i < 5; i++) expect(out).toContain(`第${i + 1}段落`);
  });

  it('still deduplicates true duplicates', () => {
    const p = 'This paragraph is definitely longer than forty characters for the dedup check.';
    const out = deduplicateParagraphs([p, p, p, p].join('\n\n'));
    expect(out.split(p).length - 1).toBe(2); // first + one allowed repeat
  });
});

describe('quality gate — CJK word counting', () => {
  it('countWords counts Japanese words, not space-separated tokens', () => {
    const ja = '人工知能は現代社会を大きく変えつつあります。多くの研究者がこの分野で活発に議論しています。';
    expect(countWords(ja)).toBeGreaterThan(10);
  });

  it('a real Japanese article passes the thin-content gate', () => {
    const ja = '人工知能の研究は近年めざましい進歩を遂げ、医療・製造業・教育など幅広い分野で応用が進んでいます。'.repeat(6);
    expect(checkContentQuality(ja).pass).toBe(true);
  });

  it('real Japanese text is not flagged as OCR garbage', () => {
    const ja = 'これは正常な日本語の文章です。文字化けではありません。'.repeat(5);
    expect(looksLikeOcrGarbage(ja)).toBe(false);
  });
});

describe('outline — non-Latin headings merge correctly', () => {
  const mk = (id: string, heading: string, notes: string[]): ResearchOutline => ({
    version: 1,
    sections: [{ id, heading, goal: '', keyTerms: [], evidenceNotes: notes, status: 'thin' }],
  });

  it('distinct Japanese headings are NOT unified (fuzzyKey empty-string collision)', () => {
    const prior = mk('s1', '背景と関連研究', ['n1', 'n2']);
    const next = mk('s2', '実験結果の分析', ['a', 'b']);
    const merged = mergeOutlines(prior, next);
    expect(merged.sections).toHaveLength(2); // s1 re-appended, not swallowed
  });
});

describe('unicode-text helpers', () => {
  it('unicodeTokens handles mixed scripts', () => {
    expect(unicodeTokens('Müller tutkimus 研究 مرحبا')).toEqual(['müller', 'tutkimus', '研究', 'مرحبا']);
  });
  it('meaningfulTokens keeps single CJK chars, drops single Latin', () => {
    expect(meaningfulTokens('a 水 b test')).toEqual(['水', 'test']);
  });
});

describe('chunk offsets — charStart/charEnd index the cleaned content exactly', () => {
  const cases: Array<[string, string]> = [
    ['headed sections', '## Intro\n\nFirst paragraph here with enough text to chunk properly.\n\n## Body\n\nSecond paragraph, also long enough to stand alone as a chunk.'],
    ['tiny-paragraph merge', '## A\n\nShort.\n\nThis second paragraph is long enough to be a real chunk on its own merits.'],
    ['trailing tiny glue', '## A\n\nA leading paragraph with enough content to become a chunk by itself.\n\nTiny.'],
    ['sentence split', '## A\n\n' + Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} exists to push this paragraph well past the maximum chunk size limit.`).join(' ')],
    ['CRLF line endings', '## A\r\n\r\nA paragraph with carriage returns and enough text to form a chunk.\r\n\r\nAnother one follows right behind it here.'],
  ];

  for (const [name, raw] of cases) {
    it(name, () => {
      const chunks = chunkDocument({ docShortId: 'doff01', content: raw });
      expect(chunks.length).toBeGreaterThan(0);
      const cleaned = cleanContent(splitFrontmatter(raw).body);
      for (const c of chunks) {
        const span = cleaned.slice(c.charStart, c.charEnd);
        // Sentence-split sub-chunks may have an overlap prefix (last sentence
        // of the prior chunk prepended for context). The original span from the
        // document is always a suffix of chunk.text.
        expect(c.text.endsWith(span) || c.text === span).toBe(true);
      }
    });
  }
});
