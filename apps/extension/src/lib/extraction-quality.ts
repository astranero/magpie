// ─────────────────────────────────────────────
// Did the extraction actually get the page?
// ─────────────────────────────────────────────
// There is no way to make a heuristic extractor work on EVERY site. Readability
// is a scoring algorithm; some layout will always score wrong. What CAN be
// guaranteed is that a bad extraction is detected instead of shipped silently.
//
// Today's failure mode is invisible: Readability returns a plausible-looking
// article, the code sees a non-empty string and moves on, and the user gets a
// document missing the part they wanted. No error, no warning, no signal.
//
// So: compare what we captured against what the page actually contains. If we
// kept a small fraction of a large page, we did not extract — we sampled. That
// is a fact about the numbers, not about any particular site, which is why it
// keeps working on sites nobody has tested yet.

export interface CoverageVerdict {
  /** Fraction of the page's text the extraction kept, 0-1. */
  ratio: number;
  /** True when the extraction plausibly represents the page. */
  ok: boolean;
  /** Set when the page looks like a bot check rather than content. */
  blocked: boolean;
  /** Short human-readable reason when !ok — safe to show a user. */
  reason?: string;
}

/**
 * Below this fraction of the page's own text, an extraction is a sample rather
 * than a capture. Deliberately low: legitimate article extraction routinely
 * discards 70-80% of a page (nav, sidebars, footers, comments), so anything
 * near that is normal and must NOT trip.
 */
export const MIN_COVERAGE = 0.12;

/**
 * Pages under this many characters are exempt. A short page is legitimately
 * short; ratios on tiny inputs are noise.
 */
export const MIN_PAGE_CHARS = 4000;

/** An extraction this small is thin regardless of ratio. */
export const MIN_EXTRACT_CHARS = 400;

/**
 * Bot-check interstitials. These are pages the operator serves INSTEAD of
 * content — a scraper that treats them as content stores a document whose whole
 * body is "Verifying you are human", and the model then answers from it.
 *
 * Detecting them is not circumventing them. The point is to tell the user what
 * happened so they can open the page themselves, in their own session, where
 * the check has already passed.
 */
const CHALLENGE_MARKERS = [
  'just a moment',
  'checking your browser',
  'verifying you are human',
  'enable javascript and cookies to continue',
  'attention required',
  'cf-browser-verification',
  'cf_chl_opt',
  'ddos protection by',
  'please verify you are a human',
  'access denied',
  'request unsuccessful. incapsula',
  'pardon our interruption',
];

/** True when the text is an anti-bot interstitial rather than page content. */
export function looksLikeChallengePage(text: string): boolean {
  if (!text) return false;
  // Challenge pages are SHORT. A long article mentioning "access denied" in
  // prose must not be mistaken for one.
  const head = text.slice(0, 4000).toLowerCase();
  if (text.length > 12000) return false;
  return CHALLENGE_MARKERS.some(m => head.includes(m));
}

/**
 * Judge an extraction against the page it came from.
 *
 * `pageText` is the page's own visible text (body innerText, or the raw HTML
 * stripped of tags — an approximation is fine, this is a ratio not a
 * measurement).
 */
export function assessCoverage(extracted: string, pageText: string): CoverageVerdict {
  const ex = (extracted || '').trim();
  const page = (pageText || '').trim();

  if (looksLikeChallengePage(ex) || (ex.length < MIN_EXTRACT_CHARS && looksLikeChallengePage(page))) {
    return {
      ratio: 0, ok: false, blocked: true,
      reason: 'The site returned a bot check instead of the page. Open it in a browser tab and capture it there — your own session has already passed the check.',
    };
  }

  const ratio = page.length > 0 ? ex.length / page.length : 1;

  // Short pages are exempt: a 500-char page extracted to 400 chars is fine.
  if (page.length < MIN_PAGE_CHARS) return { ratio, ok: true, blocked: false };

  if (ex.length < MIN_EXTRACT_CHARS) {
    return {
      ratio, ok: false, blocked: false,
      reason: 'Almost nothing could be read from this page — its content may be rendered in a way the extractor cannot see.',
    };
  }

  if (ratio < MIN_COVERAGE) {
    return {
      ratio, ok: false, blocked: false,
      reason: `Only about ${Math.round(ratio * 100)}% of this page was captured — the rest may be in a layout the extractor skipped.`,
    };
  }

  return { ratio, ok: true, blocked: false };
}

/**
 * Rough visible-text estimate from raw HTML, for the fetched-page path where
 * there is no live DOM to ask. Drops script/style bodies and tags; good enough
 * for a ratio.
 */
export function approxPageText(html: string): string {
  return (html || '')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
