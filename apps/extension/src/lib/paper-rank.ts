// ─────────────────────────────────────────────
// Algorithmic paper ranking — no LLM involved
// ─────────────────────────────────────────────
// Deterministic quality scoring so the academic agent favors influential
// work instead of whatever the APIs happen to return first. Signals:
// citations (log-scaled), citation velocity (citations per year — lets
// strong recent work compete with old classics), influential-citation
// count (S2's filtered signal), recency, and full-text availability.
//
// Selection is deliberately NOT pure top-k: ~30% of slots go to the newest
// papers regardless of citations. Brand-new work has had no time to be
// cited; an all-citations ranking would silently exclude the current
// frontier and bias every report toward the past.

export interface RankablePaper {
  title: string;
  year?: string;
  citations?: number;
  influentialCitations?: number;
  hasFullText?: boolean;
}

export function paperQualityScore(p: RankablePaper, nowYear: number): number {
  const year = Number(p.year) || 0;
  const cites = Math.max(0, p.citations ?? 0);
  const age = year > 0 ? Math.max(1, nowYear - year + 1) : 5; // unknown year ≈ mid-age

  const citeScore = Math.log10(1 + cites);                       // 0 … ~4
  const velocity = Math.log10(1 + cites / age);                  // impact-for-age
  const influential = Math.log10(1 + (p.influentialCitations ?? 0)) * 0.5;
  const recency = year > 0 ? Math.max(0, 1 - (nowYear - year) / 10) : 0; // 0 … 1
  const fullText = p.hasFullText ? 0.5 : 0;                      // extractable > abstract-only

  return citeScore + velocity + influential + recency + fullText;
}

/**
 * Pick `limit` papers: ~70% by quality score, ~30% newest-first from the
 * remainder (the "frontier slots"). Order within the result: quality picks
 * first, then frontier picks.
 */
export function rankPapers<T extends RankablePaper>(papers: T[], limit: number, nowYear = new Date().getFullYear()): T[] {
  if (papers.length <= limit) {
    return [...papers].sort((a, b) => paperQualityScore(b, nowYear) - paperQualityScore(a, nowYear));
  }

  const byScore = [...papers].sort((a, b) => paperQualityScore(b, nowYear) - paperQualityScore(a, nowYear));
  const qualitySlots = Math.max(1, Math.round(limit * 0.7));
  const picked = byScore.slice(0, qualitySlots);
  const pickedSet = new Set(picked);

  const frontier = papers
    .filter(p => !pickedSet.has(p))
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));

  return [...picked, ...frontier.slice(0, limit - picked.length)];
}
