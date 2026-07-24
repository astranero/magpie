// ─────────────────────────────────────────────
// Library + recall query handlers
// ─────────────────────────────────────────────
// Extracted from service-worker.ts. Depend only on lib functions (db,
// vector-store, doc-meta-index) — no shared worker state. Guarded by
// e2e/capture.spec.ts (search → open → highlight).

import { listDocuments, getProject, linkDocumentToProject, getChunksForDocs } from '../lib/db';
import type { Chunk } from '../lib/db';
import { searchLibrary, resetSessionIndex } from '../lib/vector-store';
import { buildDocMeta, scoreDocsByMetadata, rrfFuse } from '../lib/doc-meta-index';

interface LexicalHit { docId: string; anchorId: string; snippet: string }

/** Cap on the semantic pass — see handleSearchLibrary. */
const SEMANTIC_SEARCH_TIMEOUT_MS = 6000;

/**
 * Embedding-free literal pass: documents whose text actually contains the
 * query — exact phrase first, then all-words-present. Runs against stored
 * content and chunks, so it answers instantly and, crucially, works before the
 * embedding model has finished loading (or when it fails entirely). Semantic
 * search alone used to miss a phrase the user could see in their own document.
 */
async function lexicalSearch(query: string, limit: number): Promise<LexicalHit[]> {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const docs = await listDocuments();

  const matched = docs.filter(d => {
    const c = (d.content || '').toLowerCase();
    return c.includes(q) || (words.length > 1 && words.every(w => c.includes(w)));
  }).slice(0, limit);
  if (matched.length === 0) return [];

  // Locate the matching chunk so click-through still lands on the passage
  // rather than dumping the reader at the top of the document.
  const chunks = await getChunksForDocs(matched.map(d => d.id)).catch(() => [] as Chunk[]);
  const byDoc = new Map<string, Chunk[]>();
  for (const c of chunks) {
    if (!byDoc.has(c.docId)) byDoc.set(c.docId, []);
    byDoc.get(c.docId)!.push(c);
  }

  return matched.map(d => {
    const cs = byDoc.get(d.id) || [];
    const hit = cs.find(c => (c.text || '').toLowerCase().includes(q))
      ?? cs.find(c => words.length > 0 && words.every(w => (c.text || '').toLowerCase().includes(w)));
    const source = hit?.text || d.content || '';
    const at = source.toLowerCase().indexOf(q);
    const from = at >= 0 ? Math.max(0, at - 60) : 0;
    return {
      docId: d.id,
      anchorId: hit?.anchorId || '',
      snippet: source.replace(/\s+/g, ' ').slice(from, from + 220),
    };
  });
}

/**
 * Search across the whole library (every stored document). Returns one hit per
 * document — best-matching chunk's snippet + anchor for click-through-to-
 * highlight — joined with document metadata.
 *
 * Hybrid by design: a literal pass runs alongside the semantic one and its hits
 * rank first. An exact phrase the user can see in their own document must never
 * miss, and it must not depend on the embedding model being warm.
 */
export async function handleSearchLibrary(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const query = String(request.query || '').trim();
  if (query.length < 3) return { results: [] };

  const [lexical, semantic] = await Promise.all([
    lexicalSearch(query, 10).catch(() => [] as LexicalHit[]),
    // A cold embedder can HANG rather than reject (model load stalls), which
    // used to leave the panel on "Searching contents…" forever. Bound it: the
    // literal hits are already good, so ship them rather than wait indefinitely.
    Promise.race([
      searchLibrary(query, 10).catch(() => [] as LexicalHit[]),
      new Promise<LexicalHit[]>(resolve => setTimeout(() => resolve([]), SEMANTIC_SEARCH_TIMEOUT_MS)),
    ]),
  ]);

  const seen = new Set<string>();
  const merged = [...lexical, ...semantic].filter(h => {
    if (seen.has(h.docId)) return false;
    seen.add(h.docId);
    return true;
  }).slice(0, 10);
  if (merged.length === 0) return { results: [] };

  const docs = await listDocuments();
  const byId = new Map(docs.map(d => [d.id, d]));
  const results = merged
    .map(h => {
      const doc = byId.get(h.docId);
      if (!doc) return null;
      return {
        id: doc.id,
        title: doc.title,
        url: doc.url,
        capturedAt: doc.capturedAt,
        wordCount: doc.wordCount,
        snippet: h.snippet,
        anchorId: h.anchorId
      };
    })
    .filter(Boolean);
  return { results };
}

/**
 * /recall: pull relevant Global Lore docs into the active workspace. Ranks
 * by metadata (fast, embedding-free) fused with content hybrid search (RRF),
 * links the top matches not already in the project, returns what was linked.
 */
export async function handleRecallDocs(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const query = String(request.query || '').trim();
  const projectId = String(request.projectId || '');
  if (query.length < 2 || !projectId) return { linked: [], considered: 0 };

  const [allDocs, project] = await Promise.all([listDocuments(), getProject(projectId)]);
  const linkedSet = new Set(project?.documentIds || []);

  // Metadata ranking (all docs) + content ranking (library search)
  const metas = allDocs.map(d => buildDocMeta(d));
  const metaRanked = scoreDocsByMetadata(query, metas).map(m => m.docId);
  const contentHits = await searchLibrary(query, 20);
  const contentRanked = contentHits.map(h => h.docId);
  const snippetByDoc = new Map(contentHits.map(h => [h.docId, h.snippet]));

  const fused = rrfFuse([metaRanked, contentRanked])
    .filter(id => !linkedSet.has(id))
    .slice(0, 5);

  const titleById = new Map(allDocs.map(d => [d.id, d.title]));
  const linked: Array<{ id: string; title: string; snippet: string }> = [];
  for (const id of fused) {
    await linkDocumentToProject(projectId, id);
    linked.push({ id, title: titleById.get(id) || 'Untitled', snippet: snippetByDoc.get(id) || '' });
  }
  if (linked.length > 0) resetSessionIndex(projectId); // pick up new chunks
  return { linked, considered: metaRanked.length + contentRanked.length };
}
