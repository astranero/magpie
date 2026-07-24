// ─────────────────────────────────────────────
// Memory regression guard: LIST_DOCUMENTS payload size
// ─────────────────────────────────────────────
// The global document list (no projectId) is a getAll() over EVERY doc the user
// ever captured. Shipping each doc's full markdown body ratcheted the sidepanel
// heap into the GBs on panel open (measured 328 MB → 2 GB). handleListDocuments
// strips the global list to frontmatter-only. These tests LOCK that in: a future
// change that re-ships full bodies (or breaks tag classification) fails here.

import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub the db + vector-store the handler pulls in, so we control listDocuments'
// output and don't touch IndexedDB / Orama.
const listDocumentsMock = vi.fn();
vi.mock('../../lib/db', () => ({
  listDocuments: (...a: unknown[]) => listDocumentsMock(...a),
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocumentCount: vi.fn(),
  updateDocumentSelection: vi.fn(),
  linkDocumentToProject: vi.fn(),
  unlinkDocumentFromProject: vi.fn(),
}));
vi.mock('../../lib/vector-store', () => ({ resetLibraryIndex: vi.fn() }));

import { handleListDocuments } from '../document-handlers';

// A doc whose markdown body is deliberately huge (~200 KB) but whose frontmatter
// carries the classification tag the list UI needs.
const BODY = 'x'.repeat(200_000);
function bigDoc(id: string, tag = 'research-source') {
  const content = `---\ntitle: Doc ${id}\ntags: [${tag}]\ncaptured: 2026-01-01\n---\n\n# Heading ${id}\n\n${BODY}`;
  return { id, title: `Doc ${id}`, url: `https://x/${id}`, content, capturedAt: '2026-01-01', wordCount: 5, syncedToDrive: false, enabled: true };
}

afterEach(() => { listDocumentsMock.mockReset(); });

describe('LIST_DOCUMENTS payload guard', () => {
  it('global list (no projectId) strips each doc to a small frontmatter-only body', async () => {
    listDocumentsMock.mockResolvedValue([bigDoc('a'), bigDoc('b'), bigDoc('c')]);
    const res = await handleListDocuments({});
    const docs = res.documents as Array<{ content: string }>;
    expect(docs).toHaveLength(3);
    // Each doc's shipped content must be a tiny fraction of the 200 KB body.
    for (const d of docs) expect(d.content.length).toBeLessThan(2_000);
    // And the whole payload stays bounded regardless of how big the bodies were.
    const bytes = JSON.stringify(res).length;
    expect(bytes).toBeLessThan(20_000);
  });

  it('preserves frontmatter tags so isResearchSource() still classifies docs', async () => {
    listDocumentsMock.mockResolvedValue([bigDoc('a', 'research-source')]);
    const res = await handleListDocuments({});
    const [doc] = res.documents as Array<{ content: string }>;
    // The tag lives in the frontmatter block — it must survive the strip.
    expect(doc.content).toContain('research-source');
    expect(doc.content.startsWith('---')).toBe(true);
    // …but the huge body must be gone.
    expect(doc.content).not.toContain(BODY);
  });

  it('per-project list keeps full bodies (bounded set; feeds export/open)', async () => {
    listDocumentsMock.mockResolvedValue([bigDoc('a')]);
    const res = await handleListDocuments({ projectId: 'p1' });
    const [doc] = res.documents as Array<{ content: string }>;
    expect(doc.content).toContain(BODY); // full content retained
    expect(listDocumentsMock).toHaveBeenCalledWith('p1');
  });

  it('a doc with no frontmatter ships empty content, not the raw body', async () => {
    const naked = { id: 'n', title: 'N', url: '', content: BODY, capturedAt: '2026-01-01', wordCount: 1, syncedToDrive: false, enabled: true };
    listDocumentsMock.mockResolvedValue([naked]);
    const res = await handleListDocuments({});
    const [doc] = res.documents as Array<{ content: string }>;
    expect(doc.content).toBe('');
  });
});
