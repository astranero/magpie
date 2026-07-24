// ─────────────────────────────────────────────
// Context retrieval — selecting WHICH page links / repo files to load
// ─────────────────────────────────────────────
// A page-grounded chat turn shouldn't dump the whole repo tree and every link
// into the prompt (slow, noisy) nor miss the one file/link that holds the
// answer (unreliable). This module holds the PURE selection logic shared by all
// three strategies (semantic / router / agentic); network + offscreen deps are
// injected so it stays unit-testable.

import { matchFilesInTree, questionKeywords, lexicalLinkMatch, expandNavKeywords, isPageMetaQuestion } from './query-intent';

// ── Hard caps: the "enough to answer, not so much it's slow/noisy" contract ──
//
// These four move TOGETHER — raising one alone does nothing:
//   • MAX_LINKS is BREADTH (links followed from the current page), not depth.
//     Following is one hop by construction; multi-hop A→B→C does not exist on
//     this path and would be a feature, not a constant.
//   • MAX_SELECTED is the real binding cap, and it is SUBTRACTIVE with files —
//     at 4, a repo page matching 3 files could follow exactly 1 link no matter
//     what MAX_LINKS said.
//   • TOTAL_CTX_BUDGET / LINKED_PAGE_BUDGET (8k) is a hard ceiling on links
//     that fit: at 40k that is 5, so MAX_LINKS above ~4 is silently absorbed.
//   • FETCH_DEADLINE_MS was the constraint that actually bound: the scraper's
//     own primary path budgets 20s and empirically takes 10-13s, so an 8s
//     deadline cut fetches off mid-flight and made extra breadth worthless.
// All four are I/O-only — no ONNX, no persisted documents, no peak-memory
// change. The cost of raising them is wall-clock and prompt tokens.
export const MAX_FILES = 3;
export const MAX_LINKS = 4;
export const MAX_SELECTED = 6;              // combined files + links per turn
export const TOTAL_CTX_BUDGET = 40_000;     // chars across everything fetched
export const FETCH_DEADLINE_MS = 15_000;    // wall-clock cap on the fetch phase
const RERANK_MIN_SCORE = 0;                 // ms-marco logit: "more likely relevant than not"
// Links use the same bar as files. A higher bar (0.6) made the model stop
// following relevant links ("what about other series?" → nothing). Precision now
// comes from lexical-first matching + the isPageMetaQuestion gate (which keeps
// "summarize this page" from rerank-following anything), not from a strict score.
const LINK_RERANK_MIN_SCORE = RERANK_MIN_SCORE;
const RERANK_MAX_CANDIDATES = 80;           // never rerank thousands of labels (bounded, OOM-safe)

/** A followable link on the current page. */
export interface LinkRef { url: string; anchorText?: string }

/** Reranker: score each passage against the query. Injected (offscreen model). */
export type RerankFn = (query: string, passages: string[]) => Promise<number[] | null>;

/** What the selector decided to load — resolved by the caller into fetches. */
export interface Selection {
  files: string[];              // repo paths
  links: { url: string; title: string }[];
}

/**
 * Rank a bounded candidate pool by reranker score, keeping only confident hits.
 * Returns candidates in descending relevance. Empty on scorer failure — we never
 * fetch unscored guesses.
 */
async function rankBySemantic<T>(
  question: string,
  pool: T[],
  labelOf: (t: T) => string,
  rerank: RerankFn,
  max: number,
  minScore = RERANK_MIN_SCORE,
): Promise<T[]> {
  if (pool.length === 0) return [];
  const bounded = pool.slice(0, RERANK_MAX_CANDIDATES);
  let scores: number[] | null = null;
  try { scores = await rerank(question, bounded.map(labelOf)); } catch { scores = null; }
  if (!scores) return [];
  return bounded
    .map((t, i) => ({ t, s: scores![i] ?? 0 }))
    .filter(x => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(x => x.t);
}

/**
 * SEMANTIC strategy: pick the repo files and page links most relevant to the
 * question, under the combined MAX_SELECTED cap (files take priority).
 *
 * Files: explicit filename/identifier matches (matchFilesInTree) win outright.
 * Otherwise, when a question keyword appears in a path ("auth" → src/auth/*.ts),
 * rerank that keyword-filtered subset — this is the reliability win over the old
 * "names no file → fetch nothing" behaviour. If no path carries the concept, no
 * file is guessed (path names rarely encode deep concepts; that's the agentic
 * strategy's job).
 *
 * Links: a question keyword (nav-expanded, so pricing → "Plans"/"Billing") on a
 * link's text/href is the obvious next hop — follow it. If nothing lexically
 * matches, the reranker picks the link that best fits the QUESTION — but only
 * for a concrete topical ask (not "summarize this page") and only when it clears
 * a confident bar, so a merely-nearest tangential link is never followed.
 */
export async function selectSemantic(
  question: string,
  filePaths: string[],
  links: LinkRef[],
  rerank: RerankFn,
): Promise<Selection> {
  const keywords = questionKeywords(question);

  // ── Files ──
  let files: string[] = matchFilesInTree(filePaths, question, MAX_FILES);
  if (files.length === 0 && keywords.length > 0) {
    const pool = filePaths.filter(p => {
      const lp = p.toLowerCase();
      return !p.endsWith('/') && keywords.some(k => lp.includes(k));
    });
    files = await rankBySemantic(question, pool, p => p, rerank, MAX_FILES);
  }

  // ── Links ──
  // 1) Lexical, expanded to navigational synonyms (pricing → "Plans"/"Billing").
  const linkKeywords = keywords.length ? expandNavKeywords(keywords) : keywords;
  let picked: LinkRef[] = linkKeywords.length ? links.filter(l => lexicalLinkMatch(l, linkKeywords)) : [];
  // 2) Smart fallback: no lexical hit → let the reranker choose the link that
  //    best answers the QUESTION. Gated to concrete topical asks (skip page-
  //    summary/meta) and to a confident score, so tangential links stay out.
  if (picked.length === 0 && keywords.length && !isPageMetaQuestion(question)) {
    picked = await rankBySemantic(
      question, links, l => `${l.anchorText || ''} ${l.url}`, rerank, MAX_LINKS, LINK_RERANK_MIN_SCORE,
    );
  }
  const chosenLinks = picked.slice(0, MAX_LINKS).map(l => ({ url: l.url, title: l.anchorText || l.url }));

  // ── Combined cap: files first, then links up to MAX_SELECTED ──
  files = files.slice(0, MAX_FILES);
  const linkBudget = Math.max(0, MAX_SELECTED - files.length);
  return { files, links: chosenLinks.slice(0, linkBudget) };
}

/**
 * ROUTER strategy parse: validate the small JSON the LLM returns against what
 * actually exists on the page, so a hallucinated path/url never becomes a fetch.
 * Tolerant of ```json fences and surrounding prose. Returns null when unparseable
 * (caller then falls back to `selectSemantic`).
 */
export function parseRouterSelection(
  raw: string,
  validFiles: string[],
  links: LinkRef[],
): { files: string[]; links: { url: string; title: string }[]; web: boolean } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;

  const fileSet = new Set(validFiles);
  const linkByUrl = new Map(links.map(l => [l.url, l]));
  const fileList: string[] = Array.isArray(obj.files)
    ? obj.files.filter((f: unknown): f is string => typeof f === 'string' && fileSet.has(f))
    : [];
  const linkList: string[] = Array.isArray(obj.links)
    ? obj.links.filter((u: unknown): u is string => typeof u === 'string' && linkByUrl.has(u))
    : [];
  const files = [...new Set(fileList)].slice(0, MAX_FILES);
  const chosenLinks = [...new Set(linkList)].slice(0, MAX_LINKS)
    .map(u => ({ url: u, title: linkByUrl.get(u)!.anchorText || u }));
  return { files, links: chosenLinks, web: obj.web === true };
}

/**
 * Fetch selected items in parallel under a shared char budget and a wall-clock
 * deadline, returning inlined prompt blocks + a clickable source list. Item
 * fetchers (`fetchOne`) are injected; failures and the deadline degrade to fewer
 * blocks rather than throwing.
 */
export async function fetchWithinBudget<T>(
  items: T[],
  fetchOne: (item: T, signal: AbortSignal) => Promise<{ block: string; chars: number; source?: { title: string; url: string } } | null>,
  opts: { budget?: number; deadlineMs?: number } = {},
): Promise<{ blocks: string[]; sources: { title: string; url: string }[] }> {
  const budget = opts.budget ?? TOTAL_CTX_BUDGET;
  const deadlineMs = opts.deadlineMs ?? FETCH_DEADLINE_MS;
  if (items.length === 0) return { blocks: [], sources: [] };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const settled = await Promise.allSettled(items.map(it => fetchOne(it, ac.signal)));
    const blocks: string[] = [];
    const sources: { title: string; url: string }[] = [];
    let used = 0;
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (used + r.value.chars > budget) continue;   // keep the whole set bounded
      used += r.value.chars;
      blocks.push(r.value.block);
      if (r.value.source) sources.push(r.value.source);
    }
    return { blocks, sources };
  } finally {
    clearTimeout(timer);
  }
}
