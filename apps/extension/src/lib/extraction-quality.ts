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

// Challenge detection is NOT reimplemented here. lib/quality-gate.ts already
// carries the pattern list (Cloudflare, PerimeterX, DataDome, JS-required
// walls) and the short-content guard that stops a long article ABOUT captchas
// from being mistaken for one. It was written for the research scrape path,
// which rejects such a URL; these paths need the same question answered for a
// different reason — to tell the user why a page they are looking at came back
// empty. Two lists would drift the first time a provider changed its wording.
import { looksLikeChallengePage } from './quality-gate';
export { looksLikeChallengePage };

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

/**
 * Demote runaway headings — a paragraph that got captured as a heading.
 *
 * Turndown maps <h1>–<h6> to `# …` faithfully, but some sites (chat UIs,
 * app shells) wrap a whole sentence or paragraph in a heading tag, so a
 * 400-character block arrives as one giant `#` line. A real heading is short
 * and rarely reads as a full sentence; this converts an over-long or clearly
 * sentence-shaped heading back into plain text. Pure and conservative — a
 * genuinely short heading is never touched.
 */
export function demoteRunawayHeadings(markdown: string, maxLen = 100): string {
  return (markdown || '').split('\n').map(line => {
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (!m) return line;
    const text = m[2];
    // A heading is a label, not prose. Demote when it is long, OR when it runs
    // to multiple sentences (a period/!/? mid-line followed by more words) —
    // both are the signature of a paragraph mis-tagged as a heading.
    const tooLong = text.length > maxLen;
    const multiSentence = /[.!?]\s+\S/.test(text) && text.length > 40;
    return (tooLong || multiSentence) ? text : line;
  }).join('\n');
}

/**
 * Clean chat-UI noise out of a DOM subtree BEFORE Readability/Turndown run.
 * Mutates in place. Works on a real DOM (content script) and on linkedom (parse
 * worker) — only querySelectorAll / removeAttribute / remove are used.
 *
 * Two things, both seen on Gemini/ChatGPT-style pages:
 *  - Screen-reader-only text (`.cdk-visually-hidden`, `sr-only`, …) is invisible
 *    to a sighted reader, so capturing it leaks labels like "Sinä sanoit"
 *    ("You said") into the document.
 *  - The user's query bubble is marked `role="heading" aria-level="2"` for
 *    accessibility. That is NOT a document heading; left in place it can be
 *    captured as one (or picked as the title). Strip the heading semantics from
 *    any non-`<h1>-<h6>` element so it captures as ordinary prose.
 */
export function sanitizeCaptureDom(root: any): void {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  const dropSel = '.cdk-visually-hidden, [class*="visually-hidden"], [class*="visuallyhidden"], [class*="sr-only"], [class*="screen-reader"]';
  for (const el of Array.from(root.querySelectorAll(dropSel)) as any[]) {
    try { el.remove?.(); } catch { /* detached / read-only node — skip */ }
  }

  for (const el of Array.from(root.querySelectorAll('[role="heading"]')) as any[]) {
    const tag = String(el.tagName || '').toLowerCase();
    if (!/^h[1-6]$/.test(tag)) {
      try { el.removeAttribute?.('role'); el.removeAttribute?.('aria-level'); } catch { /* skip */ }
    }
  }
}
