import { describe, it, expect, vi, beforeEach } from 'vitest';

// Library search must answer from stored text alone. These tests pin the two
// failure modes that made an exact phrase in the user's own document miss:
// a cold embedder that HANGS, and one that throws.

const listDocuments = vi.fn();
const getChunksForDocs = vi.fn();
const searchLibrary = vi.fn();

vi.mock('../../lib/db', () => ({
  listDocuments: (...a: unknown[]) => listDocuments(...a),
  getChunksForDocs: (...a: unknown[]) => getChunksForDocs(...a),
  getProject: vi.fn(),
  linkDocumentToProject: vi.fn(),
}));
vi.mock('../../lib/vector-store', () => ({
  searchLibrary: (...a: unknown[]) => searchLibrary(...a),
  resetSessionIndex: vi.fn(),
}));
vi.mock('../../lib/doc-meta-index', () => ({
  buildDocMeta: vi.fn(), scoreDocsByMetadata: vi.fn(() => []), rrfFuse: vi.fn(() => []),
}));

const { handleSearchLibrary } = await import('../library-handlers');

const DOC = {
  id: 'd1',
  title: 'quokka-facts',
  url: '',
  capturedAt: '2026-01-01',
  wordCount: 31,
  content: 'The quokkas are exceptionally photogenic marsupials. They live on Rottnest Island.',
};

beforeEach(() => {
  vi.clearAllMocks();
  listDocuments.mockResolvedValue([DOC]);
  getChunksForDocs.mockResolvedValue([
    { docId: 'd1', anchorId: 'd1.s0.p0', text: 'The quokkas are exceptionally photogenic marsupials.' },
  ]);
});

describe('handleSearchLibrary', () => {
  it('finds an exact phrase when the embedder throws', async () => {
    searchLibrary.mockRejectedValue(new Error('embedder unavailable'));
    const res = await handleSearchLibrary({ query: 'photogenic marsupials' }) as any;
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('quokka-facts');
    // Anchor comes from the matching chunk so click-through lands on the passage
    expect(res.results[0].anchorId).toBe('d1.s0.p0');
  });

  it('does not hang when the embedder stalls — returns literal hits', async () => {
    vi.useFakeTimers();
    searchLibrary.mockReturnValue(new Promise(() => { /* never settles */ }));
    const pending = handleSearchLibrary({ query: 'photogenic marsupials' }) as Promise<any>;
    await vi.advanceTimersByTimeAsync(6001);
    const res = await pending;
    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('quokka-facts');
    vi.useRealTimers();
  });

  it('matches on all-words-present when the exact phrase is absent', async () => {
    searchLibrary.mockResolvedValue([]);
    const res = await handleSearchLibrary({ query: 'marsupials Rottnest' }) as any;
    expect(res.results).toHaveLength(1);
  });

  it('returns nothing for a phrase that is genuinely absent', async () => {
    searchLibrary.mockResolvedValue([]);
    const res = await handleSearchLibrary({ query: 'penguins in antarctica' }) as any;
    expect(res.results).toHaveLength(0);
  });

  it('de-duplicates a document found by both passes, keeping the literal hit', async () => {
    searchLibrary.mockResolvedValue([{ docId: 'd1', anchorId: 'semantic-anchor', snippet: 'semantic' }]);
    const res = await handleSearchLibrary({ query: 'photogenic marsupials' }) as any;
    expect(res.results).toHaveLength(1);
    expect(res.results[0].anchorId).toBe('d1.s0.p0');
  });
});
