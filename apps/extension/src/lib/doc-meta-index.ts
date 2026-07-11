// ─────────────────────────────────────────────
// Document metadata mini-index
// ─────────────────────────────────────────────
// A cheap, embedding-free ranking layer over document *metadata* (title,
// tags, type) parsed from frontmatter. Used by /recall to find relevant
// Global Lore fast, then fused with content-level hybrid search. Parsing the
// first ~2 KB of each doc is enough — the frontmatter block sits at the top.

import { splitFrontmatter, parseFrontmatterFields } from './frontmatter';

export interface DocMeta {
  docId: string;
  title: string;
  tags: string[];
  type: string;
  capturedAt: string;
}

export interface MetaScoredDoc {
  docId: string;
  score: number;
}

/** Build metadata for one document from its title + content head. */
export function buildDocMeta(doc: { id: string; title: string; content?: string; capturedAt: string }): DocMeta {
  const head = (doc.content || '').slice(0, 2048);
  const { yaml } = splitFrontmatter(head);
  let tags: string[] = [];
  let type = '';
  if (yaml) {
    const parsed = parseFrontmatterFields(yaml);
    tags = parsed.tags;
    type = new Map(parsed.fields).get('type') || '';
  }
  return { docId: doc.id, title: doc.title || '', tags, type, capturedAt: doc.capturedAt };
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'for', 'on', 'with', 'how', 'what', 'is', 'are']);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1 && !STOP.has(t));
}

/**
 * Score documents by metadata overlap with the query. Title matches weigh
 * most, tag matches next, type least. Recency breaks ties (newer wins).
 * Returns only docs with a positive score, ranked descending.
 */
export function scoreDocsByMetadata(query: string, metas: DocMeta[]): MetaScoredDoc[] {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  const scored: MetaScoredDoc[] = [];
  for (const m of metas) {
    const titleTokens = new Set(tokenize(m.title));
    const tagTokens = new Set(m.tags.flatMap(t => tokenize(t)));
    const typeTokens = new Set(tokenize(m.type));

    let score = 0;
    for (const q of qTokens) {
      if (titleTokens.has(q)) score += 3;
      if (tagTokens.has(q)) score += 2;
      if (typeTokens.has(q)) score += 1;
    }
    if (score > 0) {
      // Recency tiebreak: newer docs get a small boost (< one token match)
      const ageDays = (Date.now() - new Date(m.capturedAt).getTime()) / 86400000;
      const recency = Number.isFinite(ageDays) ? Math.max(0, 0.5 - ageDays / 365) : 0;
      scored.push({ docId: m.docId, score: score + recency });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Reciprocal Rank Fusion of two ranked docId lists (metadata + content).
 * k=60 is the standard smoothing constant. Returns fused docIds, best first.
 */
export function rrfFuse(rankedLists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((docId, rank) => {
      scores.set(docId, (scores.get(docId) || 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([docId]) => docId);
}
