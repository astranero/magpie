import { create, insert, search as oramaSearch } from '@orama/orama';
import { Chunk, listDocuments, getChunksForDocs } from './db';
import { sendToOffscreen } from './offscreen-client';
import { crumb } from './crash-log';

// Hard ceiling on how many chunks the IN-MEMORY index holds per session. A deep
// research run indexes every scraped source's chunks live (some PDFs alone are
// 500+ chunks); unbounded, the Orama store — full text + a 384-float vector + a
// BM25 index per chunk — grew until it OOM-killed the whole MV3 service worker
// mid-gather (the confirmed crash: dies at ~source 30-40 regardless of URL). The
// chunks remain in IndexedDB (keyword/vector searchable after a capped
// rehydrate), so this only bounds the heap, matching the rehydrate cap below.
const MAX_SESSION_CHUNKS = 2000;
const sessionChunkCount = new Map<string, number>();

// ─────────────────────────────────────────────
// Session Vector Store (Orama BM25)
// ─────────────────────────────────────────────
// The MV3 service worker is killed after ~30s of inactivity, which wipes
// this in-memory index. `ensureProjectIndexed` transparently rehydrates
// the index from the IndexedDB chunk store on the next search.

const sessionVectorDBs = new Map<string, any>();
// Tracks which docIds are already indexed per session, to avoid duplicate inserts.
const indexedDocIds = new Map<string, Set<string>>();

async function initSessionDB(sessionId: string) {
  const db = await create({
    schema: {
      id: 'string',
      docId: 'string',
      anchorId: 'string',
      text: 'string',
      heading: 'string',
      sectionPath: 'string',
      embedding: 'vector[384]'
    }
  });
  sessionVectorDBs.set(sessionId, db);
  indexedDocIds.set(sessionId, new Set());
  return db;
}

export async function getSessionDB(sessionId: string) {
  if (!sessionVectorDBs.has(sessionId)) {
    await initSessionDB(sessionId);
  }
  return sessionVectorDBs.get(sessionId);
}

function getIndexedSet(sessionId: string): Set<string> {
  let set = indexedDocIds.get(sessionId);
  if (!set) {
    set = new Set();
    indexedDocIds.set(sessionId, set);
  }
  return set;
}

async function insertChunks(db: any, chunks: Chunk[]) {
  let n = 0;
  for (const chunk of chunks) {
    // Bulk indexing is CPU-bound; yield a macrotask periodically so worker
    // message handlers stay responsive during research runs.
    if (++n % 25 === 0) await new Promise<void>(r => setTimeout(r, 0));
    await insert(db, {
      id: chunk.id ?? crypto.randomUUID(),
      docId: chunk.docId ?? '',
      anchorId: chunk.anchorId,
      text: chunk.text,
      heading: chunk.heading,
      sectionPath: chunk.sectionPath,
      embedding: chunk.embedding && chunk.embedding.length === 384 ? chunk.embedding : new Array(384).fill(0)
    });
  }
}

/**
 * Rehydrate the in-memory index with persisted chunks of the project's
 * documents that are not indexed yet (e.g. after a service worker restart).
 * Caps at maxChunks to avoid embedding thousands of chunks for large projects.
 */
// Prevent concurrent rehydration (chat question + research both calling this)
const rehydrating = new Map<string, Promise<void>>();

export async function ensureProjectIndexed(projectId: string, maxChunks = 2000): Promise<void> {
  // If already rehydrating this session, wait for it to finish
  const existing = rehydrating.get(projectId);
  if (existing) return existing;

  const promise = _ensureProjectIndexedInner(projectId, maxChunks);
  rehydrating.set(projectId, promise);
  try {
    await promise;
  } finally {
    rehydrating.delete(projectId);
  }
}

async function _ensureProjectIndexedInner(projectId: string, maxChunks: number): Promise<void> {
  const db = await getSessionDB(projectId);
  const indexed = getIndexedSet(projectId);

  const docs = await listDocuments(projectId);
  const missing = docs.filter(d => !indexed.has(d.id)).map(d => d.id);
  if (missing.length === 0) return;

  const chunks = await getChunksForDocs(missing);

  // Index ALL chunks (not just one per doc), capped at maxChunks
  const cur = sessionChunkCount.get(projectId) ?? 0;
  const toInsert = chunks.slice(0, Math.max(0, maxChunks - cur));
  await insertChunks(db, toInsert);
  sessionChunkCount.set(projectId, cur + toInsert.length);
  // Mark all docs as indexed (even if some chunks were cut by the cap)
  missing.forEach(docId => indexed.add(docId));
}

/**
 * Add chunks to the in-memory index. Chunks MUST have their final `id` and
 * `docId` assigned (use the chunks returned by `saveDocument`).
 * Ephemeral chunks (deep research sources) may use a synthetic docId.
 */
export async function addChunksToVectorStore(sessionId: string, chunks: Chunk[]) {
  const db = await getSessionDB(sessionId);
  const indexed = getIndexedSet(sessionId);

  // Skip docs already indexed (e.g. rehydrated before this call landed)
  const newChunks = chunks.filter(c => !c.docId || !indexed.has(c.docId));

  // Bound the in-memory heap: once the session index is full, stop inserting.
  // The chunks are already persisted in IndexedDB by saveDocument, so they stay
  // searchable (capped rehydrate); this just stops the OOM that killed the worker.
  const cur = sessionChunkCount.get(sessionId) ?? 0;
  const room = Math.max(0, MAX_SESSION_CHUNKS - cur);
  const toInsert = newChunks.slice(0, room);
  await insertChunks(db, toInsert);
  sessionChunkCount.set(sessionId, cur + toInsert.length);
  // Mark ALL new docs indexed even if capped — don't retry them next call.
  newChunks.forEach(c => { if (c.docId) indexed.add(c.docId); });
  if (toInsert.length < newChunks.length) {
    crumb('vector', 'session index full — capped', { at: cur + toInsert.length, dropped: newChunks.length - toInsert.length });
  } else if ((cur >> 7) !== ((cur + toInsert.length) >> 7)) {
    // Log the running total every ~128 chunks so a crash shows how large the
    // in-memory store was (confirms/rules out the cumulative-memory cause).
    crumb('vector', 'session chunks', { n: cur + toInsert.length });
  }
}

export async function searchSessionChunks(
  sessionId: string,
  query: string,
  limit: number = 20,
  filterDocIds?: string[],
  opts?: { priority?: boolean; qualityBoost?: (docId: string) => number }
): Promise<Chunk[]> {
  // Rehydrate persisted chunks lost to a service worker restart
  await ensureProjectIndexed(sessionId);
  const db = await getSessionDB(sessionId);

  let queryVector: number[] | null = null;
  try {
    // Through the offscreen mutex (NOT raw sendMessage): a bare embed here runs
    // concurrently with a research run's ONNX batch → WASM OOM → renderer crash.
    // `priority` lets an interactive chat query jump ahead of the run's queue so
    // the panel answers in seconds instead of freezing until the run finishes.
    const res: any = await sendToOffscreen({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: [query] }, undefined, { priority: !!opts?.priority });
    if (res?.ok && res.embeddings && res.embeddings[0]) {
      queryVector = res.embeddings[0];
    }
  } catch (e) {
    console.warn('Failed to generate query embedding, falling back to lexical search', e);
  }

  const retrieveLimit = limit * 3; // Retrieve more because we filter + rerank post-search

  // ── Strategy 1: Full query search with typo tolerance ──
  let candidateChunks = await runSearch(db, query, queryVector, retrieveLimit, 2);

  // ── Strategy 2: Keyword fallback — search individual words if full query returns few results ──
  if (candidateChunks.length < limit) {
    const words = query.split(/\s+/).filter(w => w.length > 3); // Only meaningful words
    if (words.length > 1) {
      const existingIds = new Set(candidateChunks.map(c => (c as any).id || c.anchorId));
      for (const word of words) {
        const wordResults = await runSearch(db, word, null, Math.ceil(retrieveLimit / words.length), 1);
        for (const chunk of wordResults) {
          const cid = (chunk as any).id || chunk.anchorId;
          if (!existingIds.has(cid)) {
            candidateChunks.push(chunk);
            existingIds.add(cid);
          }
        }
      }
    }
  }

  // Application-level docId filtering (Orama doesn't support array IN filters)
  if (filterDocIds && filterDocIds.length > 0) {
    const docIdSet = new Set(filterDocIds);
    candidateChunks = candidateChunks.filter(c => docIdSet.has(c.docId));
  }

  if (candidateChunks.length === 0) return [];

  // Local Cross-Encoder Reranking + relevance gate (see gateRerankedChunks).
  // Through the offscreen mutex (NOT raw sendMessage): the rerank ONNX pass and
  // the query embedding above must never run at once, or the WASM heap OOMs and
  // crashes the renderer. Same interactive priority as the query embed.
  try {
    const rerankRes: any = await sendToOffscreen({
      action: 'OFFSCREEN_RERANK',
      query,
      passages: candidateChunks.map(c => c.text)
    }, undefined, { priority: !!opts?.priority });

    if (rerankRes?.ok && rerankRes.scores) {
      const scored = candidateChunks.map((chunk, idx) => ({
        chunk,
        score: rerankRes.scores[idx] ?? 0
      }));
      // Source-quality boost (citations/tier) reorders the top-k AMONG relevant
      // chunks — never admits an off-topic one (the gate stays on raw relevance).
      const boost = opts?.qualityBoost
        ? (c: Chunk) => opts.qualityBoost!((c as any).docId)
        : undefined;
      const selected = gateRerankedChunks(scored, limit, boost);
      // Tag each survivor with its rerank score so callers can judge
      // confidence (e.g. chat's web fallback fires when the best match is only
      // borderline noise). Additive field — chunk shape is otherwise unchanged.
      const scoreOf = new Map(scored.map(s => [s.chunk, s.score]));
      for (const c of selected) (c as any).rerankScore = scoreOf.get(c);
      return selected;
    }
  } catch (e) {
    console.warn('Local reranking failed, returning candidate chunks directly', e);
  }

  return candidateChunks.slice(0, limit);
}

// ── Rerank relevance gate (pure — unit tested) ──
// ms-marco-MiniLM logits: genuinely relevant pairs score ≳ 0, borderline
// sits around -4, and off-topic/boilerplate lands ≤ -8. Chunks below the
// gate are dropped entirely rather than padded up to `limit` — feeding the
// model irrelevant chunks is what produces bogus citations.
export const RERANK_MIN_SCORE = -4;
export const RERANK_JUNK_SCORE = -8;

// "Trust the workspace to answer" needs a HIGHER bar than "show this chunk".
// RERANK_MIN_SCORE (-4) is the display gate — borderline keyword overlap clears
// it, so a question like "weather tomorrow" pulls chunks that trip the citation
// refusal instead of escalating to the web. Genuine relevance is ≳ 0, so we
// only treat the workspace as authoritative when the best chunk clears 0.
export const CONFIDENT_MATCH_SCORE = 0;

/**
 * Does the retrieved set genuinely answer the query, or is it borderline
 * keyword noise? Chat uses this to decide whether to ground on the workspace
 * or fall through to a web search. Chunks carry a `rerankScore` (attached by
 * searchSessionChunks). When scores are absent the reranker was unavailable —
 * we don't second-guess a non-empty result then. Pure + unit-tested.
 */
export function isConfidentMatch(chunks: Array<{ rerankScore?: number }>): boolean {
  if (chunks.length === 0) return false;
  const scores = chunks
    .map(c => c.rerankScore)
    .filter((s): s is number => typeof s === 'number');
  if (scores.length === 0) return true; // reranker unavailable → keep the match
  return Math.max(...scores) > CONFIDENT_MATCH_SCORE;
}

/**
 * Relative "score cliff": when the top hit is confident (>0), candidates
 * scoring far below it are keyword-coincidence noise even if they clear the
 * absolute gate. Logit-space analog of the sigmoid-cliff pattern used in
 * production rerankers.
 */
const RERANK_CLIFF = 7;

export function gateRerankedChunks<T>(
  scored: Array<{ chunk: T; score: number }>,
  limit: number,
  boost?: (chunk: T) => number,
): T[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  let relevant = sorted.filter(s => s.score > RERANK_MIN_SCORE);
  if (relevant.length > 0 && relevant[0].score > 0) {
    relevant = relevant.filter(s => s.score > relevant[0].score - RERANK_CLIFF);
  }
  if (relevant.length > 0) {
    // Reorder the RELEVANT survivors by relevance + source-quality boost so the
    // report leans on high-citation / high-authority sources. The relevance GATE
    // above is untouched, so a high-quality but off-topic chunk still never enters.
    const ranked = boost
      ? [...relevant].sort((a, b) => (b.score + boost(b.chunk)) - (a.score + boost(a.chunk)))
      : relevant;
    return ranked.slice(0, limit).map(s => s.chunk);
  }
  // Nothing cleared the gate. Keep the 2 best only if they're at least
  // borderline — a query with no relevant sources should return none.
  return sorted
    .filter(s => s.score > RERANK_JUNK_SCORE)
    .slice(0, 2)
    .map(s => s.chunk);
}

// ── Library-wide search ──────────────────────
// A dedicated session key indexes EVERY stored document (not just one
// workspace) so the Lore view can search the whole collection. Rehydration
// is cheap: chunks carry persisted embeddings.
const LIBRARY_SESSION = '__library__';

export interface LibrarySearchHit {
  docId: string;
  anchorId: string;
  snippet: string;
}

async function ensureLibraryIndexed(): Promise<void> {
  const db = await getSessionDB(LIBRARY_SESSION);
  const indexed = getIndexedSet(LIBRARY_SESSION);
  const docs = await listDocuments(); // no projectId → all documents
  const missing = docs.filter(d => !indexed.has(d.id)).map(d => d.id);
  if (missing.length === 0) return;
  const chunks = await getChunksForDocs(missing);
  await insertChunks(db, chunks);
  missing.forEach(id => indexed.add(id));
}

/**
 * Search the entire library; returns one hit per document (best chunk),
 * ranked by the hybrid+rerank pipeline. `limit` = max documents.
 */
export async function searchLibrary(query: string, limit: number = 8): Promise<LibrarySearchHit[]> {
  await ensureLibraryIndexed();
  const chunks = await searchSessionChunks(LIBRARY_SESSION, query, limit * 3);
  const perDoc = new Map<string, LibrarySearchHit>();
  for (const c of chunks) {
    if (!c.docId || perDoc.has(c.docId)) continue;
    perDoc.set(c.docId, {
      docId: c.docId,
      anchorId: c.anchorId,
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 220)
    });
    if (perDoc.size >= limit) break;
  }
  return [...perDoc.values()];
}

/** Drop every in-memory index (project sessions + library). */
export function resetAllSessionIndexes(): void {
  sessionVectorDBs.clear();
  indexedDocIds.clear();
  sessionChunkCount.clear();
}

/** New captures/deletions must invalidate the library-wide index too. */
export function resetLibraryIndex(): void {
  sessionVectorDBs.delete(LIBRARY_SESSION);
  indexedDocIds.delete(LIBRARY_SESSION);
  sessionChunkCount.delete(LIBRARY_SESSION);
}

/**
 * Drop the in-memory index for a session. Ephemeral chunks (deep-research
 * sources) are only in memory, so this evicts them; persisted document
 * chunks are transparently rehydrated from IndexedDB on the next search.
 * Cheap: stored chunks carry their embeddings, so no re-embedding happens.
 */
export function resetSessionIndex(sessionId: string): void {
  sessionVectorDBs.delete(sessionId);
  indexedDocIds.delete(sessionId);
  sessionChunkCount.delete(sessionId);
}

/**
 * Run an Orama search with optional vector and typo tolerance.
 */
async function runSearch(db: any, term: string, queryVector: number[] | null, limit: number, tolerance: number = 1): Promise<Chunk[]> {
  const searchParams: any = {
    term,
    properties: ['text', 'heading', 'sectionPath'],
    limit,
    tolerance  // Orama fuzzy matching — allows N character edits per token
  };

  if (queryVector) {
    searchParams.mode = 'hybrid';
    searchParams.vector = {
      value: queryVector,
      property: 'embedding'
    };
  }

  try {
    const results = await oramaSearch(db, searchParams);
    return results.hits.map(hit => hit.document as unknown as Chunk);
  } catch (e) {
    console.warn('Orama search failed for term:', term, e);
    return [];
  }
}

