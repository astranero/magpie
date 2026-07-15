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
  venue?: string;
}

// Top-tier venues (name fragments) — a prestige signal orthogonal to raw citation
// count that lets a strong paper from a landmark venue outrank a heavily-cited one
// from an obscure outlet. Matched case-insensitively as a substring of the venue.
const TOP_VENUES = /\b(nature|science|cell|lancet|nejm|new england journal|pnas|neurips|nips|\bicml\b|\biclr\b|\bcvpr\b|\biccv\b|\beccv\b|\bacl\b|emnlp|naacl|siggraph|\bkdd\b|the web conference|www '|\bchi\b|usenix|ieee symposium on security|oakland|\bsosp\b|\bosdi\b|\bfse\b|\bicse\b)\b/i;

// ── Web-domain authority (non-academic sources) ─────────────────────────────
// Web-heavy topics (design/UX, engineering practice) draw from blogs where the
// citation/venue signals above don't exist — the pool degrades to SEO content.
// A tiered authority list gives standards bodies, primary research hosts, and
// recognized empirical publishers the same kind of boost TOP_VENUES gives
// papers. Applied through the qualityBoost path, so it only REORDERS chunks
// that already cleared the relevance gate — it never admits irrelevant text.
const DOMAIN_TIERS: Array<{ re: RegExp; boost: number }> = [
  // Tier 1 (+1.0): standards bodies & primary research hosts
  { re: /(^|\.)(w3\.org|ietf\.org|whatwg\.org|iso\.org|nist\.gov|arxiv\.org|acm\.org|ieee\.org|nature\.com|science\.org|pnas\.org|nejm\.org|thelancet\.com)$/i, boost: 1.0 },
  // Tier 2 (+0.7): canonical docs & recognized empirical UX/eng research
  { re: /(^|\.)(developer\.mozilla\.org|web\.dev|nngroup\.com|baymard\.com|webaim\.org|chromium\.org|kubernetes\.io|postgresql\.org|python\.org|owasp\.org)$/i, boost: 0.7 },
  // Tier 3 (+0.4): gov/edu + major analyst & quality tech press
  { re: /\.(gov|edu|mil)$|\.ac\.[a-z]{2}$|(^|\.)(hbr\.org|mckinsey\.com|arstechnica\.com|acm\.queue)$/i, boost: 0.4 },
];

/** Authority boost for a source URL's host — 0 for unknown/malformed. */
export function webDomainAuthority(url: string): number {
  if (!url) return 0;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const m = /^(?:https?:\/\/)?([^/:?#]+)/i.exec(url);
    host = (m?.[1] || '').toLowerCase();
  }
  if (!host) return 0;
  for (const t of DOMAIN_TIERS) if (t.re.test(host)) return t.boost;
  return 0;
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
  const venue = p.venue && TOP_VENUES.test(p.venue) ? 1.0 : 0;   // landmark-venue prestige

  return citeScore + velocity + influential + recency + fullText + venue;
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
