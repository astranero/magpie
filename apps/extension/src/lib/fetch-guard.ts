// ─────────────────────────────────────────────
// Guards for the web-data agent's outbound fetches
// ─────────────────────────────────────────────
// The web-data agent lets the model construct and fetch API URLs in a loop.
// Page content is attacker-influenceable, so a hostile page could steer a fetch;
// the mitigations here are the fence:
//   - credential-free ONLY (fetchJson never sends cookies) — nothing to exfiltrate
//     from the user's logged-in sessions (see docs/SECURITY.md);
//   - a URL policy (https anywhere, http only to loopback) modelled on
//     isAllowedMcpUrl, plus asset/tracking-host rejection;
//   - size + count caps enforced by the caller loop.
// All pure except fetchJson, which takes an injectable `doFetch` for tests.

/** Hosts that only ever serve analytics/tracking — never useful API data. */
const TRACKING_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'g.doubleclick.net',
  'facebook.com/tr', 'connect.facebook.net', 'hotjar.com', 'segment.io', 'segment.com',
  'mixpanel.com', 'sentry.io', 'cloudflareinsights.com', 'clarity.ms', 'quantserve.com',
  'scorecardresearch.com', 'adservice.google.com', 'googlesyndication.com', 'criteo.com',
  'branch.io', 'amplitude.com', 'fullstory.com', 'optimizely.com', 'newrelic.com',
];

const ASSET_RE = /\.(css|js|mjs|map|ico|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|avif|mp4|webm|mp3|wasm)(\?|#|$)/i;

/**
 * Outbound-fetch policy for the web-data agent. `https://` to any host;
 * `http://` only to loopback (local dev/companion). Rejects non-http(s), static
 * assets, and pure tracking hosts. This is a fence against SSRF via a
 * page-steered URL — combined with credential-free fetches, there is no session
 * to abuse even if the model is tricked into fetching an attacker-named URL.
 */
export function isAllowedFetchUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.protocol === 'http:') {
    const h = u.hostname;
    const loopback = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
    if (!loopback) return false;
  }
  if (ASSET_RE.test(u.pathname + u.search)) return false;
  const hostPath = (u.hostname + u.pathname).toLowerCase();
  if (TRACKING_HOSTS.some(t => hostPath.includes(t))) return false;
  return true;
}

const TOKENISH_KEY = /(token|auth|sig|signature|secret|key|session|sid|password|passwd|pwd|jwt|bearer|csrf|nonce)/i;
// A value that looks like a credential: long, or high-entropy hex/base64-ish.
const TOKENISH_VALUE = /^[A-Za-z0-9._~+/-]{24,}$|^[0-9a-f]{16,}$/i;

/**
 * Normalise an observed request URL for handing to the model: keep the path and
 * param KEYS, but redact values that look like tokens/credentials (by key name
 * or by shape). Small numeric/enum values are kept so the model can still see
 * the shape of pagination/filters (`page=2`, `make=110`). Never leaks a session
 * token that happened to ride in a query string.
 */
export function redactObservedUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  for (const [k, v] of Array.from(u.searchParams.entries())) {
    if (TOKENISH_KEY.test(k) || TOKENISH_VALUE.test(v)) {
      u.searchParams.set(k, '‹redacted›');
    }
  }
  // Drop the fragment (never part of a request) and any userinfo.
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.toString();
}

export interface FetchJsonResult {
  ok: boolean;
  status: number;
  json?: any;
  text?: string;      // present when the body wasn't JSON (or JSON.parse failed)
  error?: string;
}

const DEFAULT_MAX_CHARS = 60_000;   // per-call body cap fed to the model
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Credential-free GET of a (usually JSON) API URL. NO cookies are ever sent.
 * Enforces the URL policy, a timeout, and a body-size cap. Returns parsed JSON
 * when possible, else the (capped) text. `doFetch` is injectable for tests.
 */
export async function fetchJson(
  url: string,
  opts: { signal?: AbortSignal; maxChars?: number; timeoutMs?: number; doFetch?: typeof fetch } = {}
): Promise<FetchJsonResult> {
  if (!isAllowedFetchUrl(url)) {
    return { ok: false, status: 0, error: 'URL blocked by fetch policy (https, or http to loopback only; no assets/trackers)' };
  }
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const doFetch = opts.doFetch ?? fetch;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // Explicitly credential-free: 'omit' means no cookies, even same-origin.
    const res = await doFetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'application/json, text/plain, */*' },
      signal: ctrl.signal,
    });
    const ct = res.headers.get('content-type') || '';
    // Guard against a huge body before reading it, when the server declares it.
    const len = Number(res.headers.get('content-length') || '0');
    if (len && len > 16 * 1024 * 1024) {
      return { ok: false, status: res.status, error: `Response too large (${Math.round(len / 1e6)} MB)` };
    }
    let body = await res.text();
    if (body.length > maxChars) body = body.slice(0, maxChars);
    if (/json/i.test(ct) || /^\s*[[{]/.test(body)) {
      try { return { ok: res.ok, status: res.status, json: JSON.parse(body) }; }
      catch { /* fall through to text */ }
    }
    return { ok: res.ok, status: res.status, text: body };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timed out or aborted' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
