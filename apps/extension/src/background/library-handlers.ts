// ─────────────────────────────────────────────
// Library + recall query handlers
// ─────────────────────────────────────────────
// Extracted from service-worker.ts. Depend only on lib functions (db,
// vector-store, doc-meta-index) — no shared worker state. Guarded by
// e2e/capture.spec.ts (search → open → highlight).

import { listDocuments, getProject, linkDocumentToProject } from '../lib/db';
import { searchLibrary, resetSessionIndex } from '../lib/vector-store';
import { buildDocMeta, scoreDocsByMetadata, rrfFuse } from '../lib/doc-meta-index';

/**
 * Semantic search across the whole library (every stored document). Returns
 * one hit per document — best-matching chunk's snippet + anchor for
 * click-through-to-highlight — joined with document metadata.
 */
export async function handleSearchLibrary(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const query = String(request.query || '').trim();
  if (query.length < 3) return { results: [] };

  const hits = await searchLibrary(query, 10);
  if (hits.length === 0) return { results: [] };

  const docs = await listDocuments();
  const byId = new Map(docs.map(d => [d.id, d]));
  const results = hits
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
