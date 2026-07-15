// ─────────────────────────────────────────────
// Faithfulness verifier — fast, local, model-reuse
// ─────────────────────────────────────────────
// Does each [anchor] citation's source chunk actually SUPPORT the claim it is
// attached to? We reuse the ms-marco reranker (already loaded for retrieval) as a
// cross-encoder relevance scorer — no new model, no LLM call, no extra offscreen
// heap. For each cited claim we score (claim, cited-chunk); a low score means the
// citation drifted to an unrelated chunk, so we drop that [anchor].
//
// This is RELEVANCE-grade faithfulness: it catches "the source isn't about this
// claim". It does NOT catch a claim that CONTRADICTS a relevant source, or a
// wrong number pulled from the right chunk — that needs a dedicated NLI model,
// which we intentionally avoid (it would re-inflate the offscreen renderer heap
// we spent real effort bounding).

// Anchors look like [d3.s2.p4] or [d3ab01.s0.p1.0] — alphanumeric dot-segments,
// at least one dot (so this never matches plain [1] footnote numbers). Build a
// FRESH global regex per use: a shared /g/ regex leaks `lastIndex` between the
// exec() scan and the replace() inside claimBefore, which corrupts the scan
// (infinite loop). Never make this a shared module-level global regex.
const ANCHOR_SRC = '\\[([a-z0-9]+(?:\\.[a-z0-9]+)+)\\]';
const anchorRe = () => new RegExp(ANCHOR_SRC, 'gi');

export interface FaithfulnessDeps {
  /** Reranker: score how well each evidence supports the claim (0..1, sigmoid). */
  rerank: (claim: string, evidences: string[]) => Promise<number[]>;
  /** Resolve an anchorId to its source chunk text (null if unknown). */
  getChunkText: (anchorId: string) => Promise<string | null>;
}

export interface FaithfulnessResult {
  text: string;      // synthesis with unsupported citations removed
  total: number;     // citations checked (that resolved to a chunk)
  verified: number;
  dropped: number;
}

/**
 * The claim prose immediately preceding an anchor: back to the previous sentence
 * boundary, with any other anchor markers stripped. Capped so a runaway paragraph
 * can't blow up the reranker input.
 */
export function claimBefore(text: string, pos: number): string {
  const upto = text.slice(Math.max(0, pos - 400), pos);
  const b = Math.max(
    upto.lastIndexOf('. '), upto.lastIndexOf('.\n'),
    upto.lastIndexOf('! '), upto.lastIndexOf('? '),
    upto.lastIndexOf('\n'), upto.lastIndexOf('; '),
  );
  return upto.slice(b + 1).replace(anchorRe(), '').replace(/\s+/g, ' ').trim();
}

export async function verifyFaithfulness(
  synthesis: string,
  deps: FaithfulnessDeps,
  threshold = 0.12,
): Promise<FaithfulnessResult> {
  const re = anchorRe();
  const occ: { anchor: string; start: number; end: number; claim: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(synthesis)) !== null) {
    occ.push({ anchor: m[1], start: m.index, end: m.index + m[0].length, claim: claimBefore(synthesis, m.index) });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against any zero-width match
  }
  if (occ.length === 0) return { text: synthesis, total: 0, verified: 0, dropped: 0 };

  const chunkCache = new Map<string, string | null>();
  const getChunk = async (a: string): Promise<string | null> => {
    if (!chunkCache.has(a)) chunkCache.set(a, await deps.getChunkText(a).catch(() => null));
    return chunkCache.get(a) ?? null;
  };

  // Group by claim so a sentence's trailing [a][b] verify in ONE rerank call.
  const byClaim = new Map<string, number[]>();
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i].claim) continue; // no verifiable claim text — leave the citation alone
    const arr = byClaim.get(occ[i].claim) ?? [];
    arr.push(i);
    byClaim.set(occ[i].claim, arr);
  }

  const drop = new Set<number>();
  let total = 0;
  for (const [claim, idxs] of byClaim) {
    const resolved: { i: number; chunk: string }[] = [];
    for (const i of idxs) {
      const c = await getChunk(occ[i].anchor);
      if (c) resolved.push({ i, chunk: c.slice(0, 1200) });
    }
    if (resolved.length === 0) continue;
    total += resolved.length;
    let scores: number[];
    try { scores = await deps.rerank(claim, resolved.map(r => r.chunk)); }
    catch { continue; } // reranker hiccup — don't drop on a failed check
    resolved.forEach((r, k) => { if ((scores[k] ?? 1) < threshold) drop.add(r.i); });
  }

  if (drop.size === 0) return { text: synthesis, total, verified: total, dropped: 0 };

  // Remove dropped anchors back-to-front so earlier indices stay valid.
  const removals = [...drop].map(i => occ[i]).sort((a, b) => b.start - a.start);
  let text = synthesis;
  for (const o of removals) text = text.slice(0, o.start) + text.slice(o.end);
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1');

  return { text, total, verified: total - drop.size, dropped: drop.size };
}
