/**
 * Where a synced document lands inside its project folder.
 *
 * The Drive folder this extension writes into is an Obsidian vault whose
 * projects all use the same layout. Sync used to drop everything flat in the
 * project root, beside `captures/` and `research/` rather than inside them.
 * Misfiling is silent — the file syncs, it is just in the wrong place — so the
 * routing rule is worth pinning down.
 */
import { describe, it, expect } from 'vitest';
import { folderForDocument, frontmatterType, PROJECT_FOLDERS } from '../vault-layout';

const fm = (type) => `---\ntitle: Something\ntype: ${type}\n---\n\nbody\n`;

describe('frontmatterType', () => {
  it('reads the type the writer declared', () => {
    expect(frontmatterType(fm('web-capture'))).toBe('web-capture');
    expect(frontmatterType(fm('flashcards'))).toBe('flashcards');
  });

  it('returns undefined when there is no frontmatter to read', () => {
    expect(frontmatterType('# Just a heading\n')).toBeUndefined();
    expect(frontmatterType('')).toBeUndefined();
    // An unterminated block is not frontmatter; guessing from it would let body
    // text that happens to say "type:" decide where the file goes.
    expect(frontmatterType('---\ntype: web-capture\n')).toBeUndefined();
  });
});

describe('folderForDocument', () => {
  it('files captured pages under captures/', () => {
    expect(folderForDocument({ url: 'https://example.com/a', title: 'A page' })).toBe('captures');
    expect(folderForDocument({ frontmatterType: 'pdf', url: '' })).toBe('captures');
    expect(folderForDocument({ frontmatterType: 'selection', url: '' })).toBe('captures');
  });

  it('files synthesized documents under research/', () => {
    // No source URL: Magpie wrote this, it did not fetch it.
    expect(folderForDocument({ url: '', title: 'Deep Research — Vector DBs' })).toBe('research');
    expect(folderForDocument({ frontmatterType: 'research-sources', url: '' })).toBe('research');
    expect(folderForDocument({ frontmatterType: 'flashcards', url: '' })).toBe('research');
  });

  it('trusts frontmatter over the URL', () => {
    // A PDF capture still has a source URL; both agree here. The point is that
    // an explicit declaration is not overridden by the URL heuristic.
    expect(folderForDocument({ frontmatterType: 'web-capture', url: '' })).toBe('captures');
  });

  it('treats a raw research scrape as captured material', () => {
    // Kept only for citation links — it came from the web, so it is a capture,
    // not one of Magpie's own reports.
    expect(folderForDocument({ url: '', isResearchSource: true })).toBe('captures');
  });

  it('routes specs and decisions by title for documents written before types', () => {
    expect(folderForDocument({ url: '', title: 'SPEC — Retrieval pipeline' })).toBe('specs');
    expect(folderForDocument({ url: '', title: 'ADR 004: use Qdrant' })).toBe('decisions');
    expect(folderForDocument({ url: '', title: 'Decision: drop Jina' })).toBe('decisions');
  });

  it('never invents a folder outside the project layout', () => {
    const cases = [
      {}, { url: '' }, { url: 'not a url' }, { url: 'ftp://x/y' },
      { frontmatterType: 'something-new' }, { title: 'x'.repeat(500) },
    ];
    for (const c of cases) expect(PROJECT_FOLDERS).toContain(folderForDocument(c));
  });
});
