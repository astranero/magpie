// ─────────────────────────────────────────────
// Content Quality Gate — reject bad scrapes before they get indexed
// ─────────────────────────────────────────────
// Publishers (ACM, IEEE, Springer…) sit behind Cloudflare; scrapes come back
// as "Just a moment…" challenge pages, paywalls, login walls, error pages.
// Indexing those produces garbage documents that later surface as irrelevant
// citations. Every scraped page passes through checkContentQuality() first.

export interface GateResult {
  pass: boolean;
  /** Rejection reason slug, e.g. "anti-bot", "paywall", "thin-content". */
  reason?: string;
}

const MIN_CHARS = 200;
const MIN_WORDS = 50;

/** Anti-bot / challenge interstitials (Cloudflare, PerimeterX, DataDome…). */
const BOT_PATTERNS: RegExp[] = [
  /just a moment/i,
  /security verification/i,
  /check(?:ing)? your browser/i,
  /performing security/i,
  /DDoS protection/i,
  /one more step/i,
  /verify (?:that )?you are (?:a )?human/i,
  /we need to check your browser/i,
  /are you a robot/i,
  /\b(?:re|h)?captcha\b/i,
];

const JS_REQUIRED_PATTERNS: RegExp[] = [
  /please enable javascript/i,
  /javascript is (?:required|disabled)/i,
  /enable js to continue/i,
];

const PAYWALL_PATTERNS: RegExp[] = [
  /subscribe to (?:read|continue|view)/i,
  /purchase (?:access|this article)/i,
  /subscription required/i,
  /you(?:'|’)ve reached your (?:article|free) limit/i,
  /this content is (?:for|available to) (?:subscribers|members)/i,
];

const LOGIN_PATTERNS: RegExp[] = [
  /sign in to (?:view|continue|read)/i,
  /log ?in to continue/i,
  /access restricted/i,
  /this (?:content|page) is private/i,
];

const ERROR_PAGE_PATTERNS: RegExp[] = [
  /page not found/i,
  /this page (?:doesn'?t|does not) exist/i,
  /\b404 error\b/i,
  /\bHTTP 404\b/i,
  /too many requests/i,
  /rate limit exceeded/i,
  /your IP has been (?:temporarily )?blocked/i,
  /under maintenance/i,
  /temporarily unavailable/i,
  /scheduled maintenance/i,
  /account (?:has been )?suspended/i,
];

/**
 * Interstitials are short — a real article that merely *mentions* "captcha"
 * or "page not found" shouldn't be rejected. Pattern checks only apply to
 * short content; long content passes on substance.
 */
const PATTERN_CHECK_MAX_WORDS = 300;

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

export function checkContentQuality(markdown: string, title?: string): GateResult {
  const text = (markdown || '').trim();
  if (text.length < MIN_CHARS) return { pass: false, reason: 'empty-content' };

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) return { pass: false, reason: 'thin-content' };

  const probe = `${title || ''}\n${text.slice(0, 2000)}`;
  if (words.length <= PATTERN_CHECK_MAX_WORDS) {
    if (matchAny(probe, BOT_PATTERNS)) return { pass: false, reason: 'anti-bot' };
    if (matchAny(probe, JS_REQUIRED_PATTERNS)) return { pass: false, reason: 'js-required' };
    if (matchAny(probe, PAYWALL_PATTERNS)) return { pass: false, reason: 'paywall' };
    if (matchAny(probe, LOGIN_PATTERNS)) return { pass: false, reason: 'login-wall' };
    if (matchAny(probe, ERROR_PAGE_PATTERNS)) return { pass: false, reason: 'error-page' };

    // Cookie wall: consent text dominating a short page
    const cookieHits = (probe.match(/\bcookies?\b/gi) || []).length;
    if (cookieHits >= 3 && words.length < 150) return { pass: false, reason: 'cookie-wall' };
  }

  return { pass: true };
}

/**
 * OCR/garbage detector for PDF extraction output: real prose is mostly
 * letters and digits; broken OCR is symbols, box chars, and soup.
 */
export function looksLikeOcrGarbage(text: string): boolean {
  const t = (text || '').trim();
  if (t.length < 100) return false; // too short to judge — let length gates decide
  const alnum = (t.match(/[a-zA-Z0-9À-ɏЀ-ӿ]/g) || []).length;
  return alnum / t.length < 0.3;
}

/** Extract a DOI from a URL or text, e.g. dl.acm.org/doi/10.1145/3583133.3596373 */
export function extractDoi(input: string): string | null {
  const m = (input || '').match(/\b(10\.\d{4,9}\/[^\s"'<>?#]+)/);
  if (!m) return null;
  // Trim trailing punctuation that URL paths pick up
  return m[1].replace(/[.,;)\]]+$/, '');
}
