import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { extractMailboxList } from './mailbox';

// ─────────────────────────────────────────────
// Enhanced Content Script — AI Research Assistant
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'SCRAPE_PAGE') {
    scrapePage().then(result => {
      // Flag a PDF-viewer page so the worker can capture the actual PDF (e.g.
      // ACM /doi/epdf/…) instead of the useless viewer HTML.
      sendResponse({ ...result, pdfUrl: looksLikePdfViewer() ? (findPdfUrl() || window.location.href) : undefined });
    }).catch(_err => {
      sendResponse({
        title: document.title || 'Untitled',
        url: window.location.href,
        favicon: getFavicon(),
        markdown: document.body?.innerText || '',
        wordCount: 0,
        pdfUrl: looksLikePdfViewer() ? (findPdfUrl() || window.location.href) : undefined
      });
    });
    return true; // Keep the message channel open for the async response
  }
  if (request.action === 'EXTRACT_PDF') {
    // Fetch the PDF FROM THE PAGE so it carries the user's session cookies —
    // paywalled PDFs the user can view are then fetchable. Bytes come back as
    // base64 (OPFS is origin-scoped, so we can't hand the extension a file).
    extractPdf(request.url as string | undefined)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});

/** Best-effort absolute PDF URL for the current page (generic, no per-site map). */
function findPdfUrl(): string | null {
  const abs = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  };
  // 1. Academic standard meta tag — the most reliable generic signal.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="citation_pdf_url"]');
  if (meta?.content) return abs(meta.content);
  // 2. Embedded PDF objects.
  const embed = document.querySelector<HTMLEmbedElement>('embed[type="application/pdf"]');
  if (embed?.getAttribute('src')) return abs(embed.getAttribute('src'));
  const obj = document.querySelector<HTMLObjectElement>('object[type="application/pdf"]');
  if (obj?.getAttribute('data')) return abs(obj.getAttribute('data'));
  // 3. An iframe pointing at a PDF-ish URL.
  const iframeSrc = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src]'))
    .map(f => f.getAttribute('src') || '')
    .find(s => /\.pdf(\?|$)|\/pdf\//i.test(s));
  if (iframeSrc) return abs(iframeSrc);
  // 4. URL heuristic for common viewer routes (ACM /doi/epdf/ → /doi/pdf/).
  if (/\/epdf\//i.test(location.href)) return location.href.replace(/\/epdf\//i, '/pdf/');
  return null;
}

/** Does the page look like a PDF VIEWER (vs. an abstract page that merely links a
 *  PDF)? Only then do we prefer capturing the PDF over the page text. */
function looksLikePdfViewer(): boolean {
  return !!document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')
    || /\/epdf\//i.test(location.href)
    || document.contentType === 'application/pdf';
}

/**
 * Best-effort absolute URL for a "raw log" endpoint on CI/build-log viewer
 * pages (Azure DevOps, GitHub Actions, GitLab, Jenkins, ...). These viewers
 * virtualize the log body — only the currently-scrolled-into-view lines
 * actually exist as DOM nodes, so `document.body.innerText` silently omits
 * everything off-screen (a 45-minute build's failure is very often near the
 * END of the log, which is exactly the part least likely to still be
 * mounted). The raw-log link, by contrast, is a real always-present anchor
 * (not part of the virtualized list) that points at the complete plain-text
 * log — fetching it sidesteps DOM virtualization entirely.
 */
function findRawLogUrl(): string | null {
  const abs = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  };
  // Azure DevOps: <a id="__bolt-download" aria-label="View raw log" href="/…/_apis/build/builds/{id}/logs/{logId}">
  const ado = document.querySelector<HTMLAnchorElement>(
    'a#__bolt-download, a[aria-label="View raw log" i], a[href*="/_apis/build/builds/"][href*="/logs/"]'
  );
  if (ado?.getAttribute('href')) return abs(ado.getAttribute('href'));
  // Generic: any link whose visible text names itself as the raw/full log —
  // covers GitLab ("Complete Raw"), Jenkins ("View as plain text"), and
  // other CI viewers without hardcoding each one.
  const generic = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .find(a => /^(view raw log|raw log|complete raw|view as plain text|download( full)? log)$/i.test((a.textContent || '').trim()));
  if (generic?.getAttribute('href')) return abs(generic.getAttribute('href'));
  return null;
}

/**
 * Truncate long text keeping BOTH ends, not just the head. A plain
 * `.slice(0, max)` (the old behavior) silently drops everything after the
 * cutoff — for a CI log, that's almost always where the actual failure is,
 * since builds run top-to-bottom and error out near the end.
 */
function truncateKeepingTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.25);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  return `${text.slice(0, headChars)}\n\n… [${omitted.toLocaleString()} characters omitted] …\n\n${text.slice(-tailChars)}`;
}

/**
 * Azure DevOps build "Summary"/"Results" pages (and the single-log viewer
 * page too — same URL shape) render a list of jobs/steps with pass/fail
 * status and duration, but NOT the actual failure text — that lives inside
 * each individual step's log, which the user has to click into one at a
 * time. Rather than trying to detect and click through the UI, use Azure
 * DevOps's own Timeline REST API: it lists every record (job/phase/task) in
 * the build with its result and — for leaf tasks — a `log.id` pointing at
 * that task's plain-text log. This traverses straight to every failing
 * step's real log content, in parallel, via network calls instead of
 * simulated navigation.
 *
 * Works for both Azure DevOps Services (dev.azure.com/{org}/{project}/_build/…)
 * and on-prem Azure DevOps Server / TFS (…/{collection}/{project}/_build/…) —
 * both use `_build` as the route segment and take `buildId` as a query param.
 */
function findAdoBuildApiBase(): { apiBase: string; buildId: string } | null {
  if (!/\/_build\//i.test(location.pathname)) return null;
  const buildId = new URLSearchParams(location.search).get('buildId');
  if (!buildId) return null;
  const base = location.origin + location.pathname.replace(/\/_build\/.*/i, '');
  return { apiBase: `${base}/_apis/build/builds/${buildId}`, buildId };
}

async function tryFetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) return await res.json();
  } catch { /* ignore — caller falls back */ }
  return null;
}

/** Hard ceiling on how many failed-step logs we fetch in one traversal —
 *  guards against a pathological build with hundreds of failing matrix jobs
 *  hammering the server. Real pipelines essentially never exceed this even
 *  across many stages, so in practice every stage's failures are captured. */
const MAX_FAILED_STEP_LOGS = 40;
/** Total character budget shared across every failed step's log, not a flat
 *  per-step cap — so a build with 2 failures gets generous room per log, and
 *  one with 20 failures (spread across several stages) still gets ALL of
 *  them, each proportionally trimmed, instead of silently dropping whichever
 *  stage's failures didn't fit under a fixed per-step limit. */
const MAX_TOTAL_FAILED_LOG_CHARS = 150_000;
const MIN_CHARS_PER_STEP_LOG = 4_000;

async function fetchAdoFailedStepLogs(apiBase: string): Promise<string> {
  // Azure DevOps requires an api-version; 6.0 is old enough to exist on both
  // current cloud and most on-prem server versions. Retry without the param
  // as a last resort for servers that reject it outright.
  const timeline = await tryFetchJson(`${apiBase}/timeline?api-version=6.0`)
    ?? await tryFetchJson(`${apiBase}/timeline`);
  const records: any[] = Array.isArray(timeline?.records) ? timeline.records : [];
  // No stage/phase filtering here — the timeline response already contains
  // every record across every stage in one flat array, and only LEAF tasks
  // carry a log.id (stages/phases don't), so this naturally reaches failures
  // nested under any stage without needing to walk the hierarchy explicitly.
  const failed = records
    .filter(r => r?.result === 'failed' && r?.log?.id != null)
    .slice(0, MAX_FAILED_STEP_LOGS);
  if (!failed.length) return '';

  const perStepBudget = Math.max(MIN_CHARS_PER_STEP_LOG, Math.floor(MAX_TOTAL_FAILED_LOG_CHARS / failed.length));

  // Fetch every failing step's log CONCURRENTLY — this is a "traverse the
  // failing links in parallel" operation, not a sequential crawl, so it
  // costs roughly one round-trip's worth of latency regardless of how many
  // steps failed.
  const results = await Promise.allSettled(
    failed.map(async (r) => {
      const res = await fetch(`${apiBase}/logs/${r.log.id}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`log ${r.log.id}: HTTP ${res.status}`);
      const text = await res.text();
      const name = r.name || r.task?.name || `Step ${r.log.id}`;
      return `## Failed step: ${name}\n\n${truncateKeepingTail(text, perStepBudget)}`;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map(r => r.value)
    .join('\n\n---\n\n');
}

/**
 * The Pipeline "Runs" history/list page (multiple past runs, e.g. showing
 * "#300.14.25-RUN-16 — Failed") is a DIFFERENT page from a single build's
 * results view: its URL carries a `definitionId`, not a `buildId`, and the
 * model has no single build to traverse into. Rather than scraping the
 * (possibly virtualized) run-list DOM for which rows say "Failed", ask Azure
 * DevOps directly for the recent failed runs of this pipeline definition,
 * then traverse into each one's failed steps — same Timeline-API approach as
 * a single build, just fanned out one level further, still in parallel.
 */
function findAdoPipelineApiBase(): { apiBase: string; definitionId: string } | null {
  if (!/\/_build(\/.*)?$/i.test(location.pathname)) return null;
  const definitionId = new URLSearchParams(location.search).get('definitionId');
  if (!definitionId) return null;
  const base = location.origin + location.pathname.replace(/\/_build.*/i, '');
  return { apiBase: `${base}/_apis/build`, definitionId };
}

/** How many recent failed runs to traverse into on the pipeline history page.
 *  Deliberately small — this is "why is the latest run failing", not a full
 *  audit of pipeline history. */
const MAX_FAILED_RUNS = 3;

async function fetchAdoRecentFailedRunsLogs(apiBase: string, definitionId: string): Promise<string> {
  const query = `definitionId=${encodeURIComponent(definitionId)}&statusFilter=completed&resultFilter=failed&$top=${MAX_FAILED_RUNS}`;
  const list = await tryFetchJson(`${apiBase}/builds?${query}&api-version=6.0`)
    ?? await tryFetchJson(`${apiBase}/builds?${query}`);
  const runs: any[] = Array.isArray(list?.value) ? list.value : [];
  if (!runs.length) return '';

  // Traverse into every failed run's failed steps CONCURRENTLY, same as the
  // single-build case — the whole multi-run fan-out costs about as much
  // latency as the slowest single run's logs, not the sum of all of them.
  const results = await Promise.allSettled(
    runs.map(async (run) => {
      const runApiBase = `${apiBase}/builds/${run.id}`;
      const failedLogs = await fetchAdoFailedStepLogs(runApiBase);
      if (!failedLogs) return '';
      const label = run.buildNumber || `Run ${run.id}`;
      return `# Run ${label} (failed)\n\n${failedLogs}`;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
    .map(r => r.value)
    .join('\n\n===\n\n');
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

// base64 transfer inflates ~1.33× and copies the bytes several times (fetch
// buffer → binary string → btoa → message). Keep the ceiling modest so a large
// PDF can't OOM the page renderer while encoding. Bigger PDFs → use Import PDF
// (streams to OPFS, no base64).
const MAX_PDF_BYTES = 25 * 1024 * 1024;
async function extractPdf(preferred?: string): Promise<Record<string, unknown>> {
  const url = preferred || findPdfUrl();
  if (!url) return { ok: false, error: 'no PDF found on this page' };
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/pdf,*/*' } });
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e?.message || e}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const ct = res.headers.get('content-type') || '';
  // Reject by Content-Length BEFORE reading the body into memory — a huge PDF
  // must never be fully buffered (that's what OOM-crashed the renderer).
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_PDF_BYTES) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, error: `PDF too large to capture inline (${Math.round(len / 1024 / 1024)} MB) — use Import PDF` };
  }
  const buf = await res.arrayBuffer();
  const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
  if (!ct.includes('application/pdf') && !head.startsWith('%PDF')) {
    return { ok: false, error: `not a PDF (got ${ct || 'unknown type'} — likely a login/paywall page)` };
  }
  if (buf.byteLength > MAX_PDF_BYTES) {   // Content-Length can lie / be absent
    return { ok: false, error: `PDF too large to capture inline (${Math.round(buf.byteLength / 1024 / 1024)} MB) — use Import PDF` };
  }
  return { ok: true, base64: bufToBase64(buf), url, title: document.title };
}

function getFavicon(): string {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
  );
  if (link?.href) return link.href;
  return `${window.location.origin}/favicon.ico`;
}

// ── YouTube transcript helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Attempt 1: fetch the timedtext caption track from the player response.
 * YouTube increasingly requires a PO token on this endpoint and answers
 * with an empty 200 — callers MUST treat an empty result as failure.
 */
async function fetchTimedtextTranscript(ytResponse: any): Promise<string> {
  const captionTracks = ytResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) return '';

  // Prefer English, fallback to first available
  const track = captionTracks.find((t: any) => t.languageCode === 'en' || t.languageCode === 'en-US' || t.languageCode === 'en-GB') || captionTracks[0];

  const jsonUrl = track.baseUrl + (track.baseUrl.includes('fmt=json3') ? '' : '&fmt=json3');
  let transcriptRes = await fetch(jsonUrl, { credentials: 'include' });
  if (!transcriptRes.ok) {
    transcriptRes = await fetch(track.baseUrl, { credentials: 'include' });
  }
  const transcriptTextRaw = await transcriptRes.text();
  if (!transcriptTextRaw.trim()) return '';

  let transcriptText = '';

  try {
    // Try parsing as JSON3
    const data = JSON.parse(transcriptTextRaw);
    if (data.events) {
      for (const event of data.events) {
        if (event.segs && event.segs.length > 0) {
          const startMs = event.tStartMs || 0;
          const mins = Math.floor(startMs / 60000);
          const secs = Math.floor((startMs % 60000) / 1000).toString().padStart(2, '0');
          const textContent = event.segs.map((s: any) => s.utf8).join('').replace(/\n/g, ' ').trim();
          if (textContent && textContent !== '\n') {
            transcriptText += `[${mins}:${secs}] ${textContent}\n`;
          }
        }
      }
    }
  } catch (e) {
    // Fallback to XML parsing if it wasn't JSON
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(transcriptTextRaw, 'text/xml');
    const textNodes = xmlDoc.getElementsByTagName('text');

    for (let i = 0; i < textNodes.length; i++) {
      const start = parseFloat(textNodes[i].getAttribute('start') || '0');
      const mins = Math.floor(start / 60);
      const secs = Math.floor(start % 60).toString().padStart(2, '0');
      const textContent = textNodes[i].textContent?.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') || '';
      transcriptText += `[${mins}:${secs}] ${textContent}\n`;
    }
  }

  return transcriptText;
}

function readTranscriptSegments(): string {
  const rows = document.querySelectorAll('ytd-transcript-segment-renderer');
  if (rows.length === 0) return '';
  let out = '';
  rows.forEach(row => {
    const ts = row.querySelector('.segment-timestamp')?.textContent?.trim() ?? '';
    const text = row.querySelector('.segment-text')?.textContent?.trim() ?? '';
    if (text) out += ts ? `[${ts}] ${text}\n` : `${text}\n`;
  });
  return out;
}

/**
 * Attempt 2: open YouTube's own transcript panel and read the segments
 * from the DOM. Runs inside the user's player session, so it is immune
 * to the PO-token requirement that breaks direct timedtext fetches.
 */
async function scrapeTranscriptPanel(): Promise<string> {
  // Panel may already be open
  let text = readTranscriptSegments();
  if (text) return text;

  // The "Show transcript" button lives in the description renderer; it is
  // clickable via JS even while the description is collapsed.
  const button =
    document.querySelector<HTMLElement>('ytd-video-description-transcript-section-renderer button') ||
    document.querySelector<HTMLElement>('button[aria-label="Show transcript"]');
  if (!button) return '';
  button.click();

  // Segments render async — poll up to 10s
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    text = readTranscriptSegments();
    if (text) break;
  }

  // Best-effort: close the panel we opened to leave the page as it was
  document.querySelector<HTMLElement>(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button'
  )?.click();

  return text;
}

/**
 * Extract a meaningful title from markdown content by looking for the first heading.
 * Falls back to the provided fallback if no heading is found.
 */
function extractTitleFromMarkdown(markdown: string, fallback: string): string {
  // Try to find the first # heading in the markdown
  const headingMatch = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (headingMatch) {
    const extracted = headingMatch[1].trim();
    // Only use it if it's reasonably long and not a generic section name
    if (extracted.length > 5 && !/^(introduction|overview|table of contents|summary|abstract)$/i.test(extracted)) {
      return extracted;
    }
  }

  // For Gemini/ChatGPT pages: try the first substantial line of content
  const lines = markdown.split('\n').filter(l => l.trim().length > 10);
  if (lines.length > 0) {
    const firstLine = lines[0].replace(/^\*\*|\*\*$/g, '').replace(/^[>#\-*]\s*/, '').trim();
    if (firstLine.length > 10 && firstLine.length < 120) {
      return firstLine;
    }
  }

  return fallback;
}

/**
 * Check if a title looks like a generic site/app name rather than content title.
 * Examples: "Google Gemini", "ChatGPT", "Claude", "Google Docs"
 */
function isGenericTitle(title: string): boolean {
  // Strip invisible unicode characters (e.g. U+200E Left-to-Right Mark from Gemini pages)
  const cleaned = title.trim().replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF\u00AD]/gu, '').trim();
  const genericPatterns = [
    /^google\s*(gemini|docs|sheets|slides|drive|ai|bard)?$/i,
    /^‎?google\s*(gemini)?$/i,   // with LTR mark prefix
    /^chatgpt/i,
    /^claude/i,
    /^perplexity/i,
    /^notion$/i,
    /^untitled$/i,
    /^new\s+(tab|page|document)$/i,
    /^gemini$/i,
  ];
  return genericPatterns.some(p => p.test(cleaned));
}

async function scrapePage(): Promise<{
  title: string;
  url: string;
  favicon: string;
  markdown: string;
  wordCount: number;
  kind?: 'web' | 'youtube';
  author?: string;
}> {
  const url = window.location.href;
  const favicon = getFavicon();
  let title = document.title || 'Untitled';

  // ── AZURE DEVOPS BUILD PAGE: traverse straight to every failing step's log ──
  // Works whether the user is on the build's Summary/Results overview (which
  // only shows step names + pass/fail + duration, never the actual error) or
  // a single step's log viewer — either way, this pulls the real failure text
  // for every failed step via the Timeline API, in parallel, instead of
  // requiring the user (or the model) to click into each one.
  const adoBuild = findAdoBuildApiBase();
  if (adoBuild) {
    try {
      const failedLogs = await fetchAdoFailedStepLogs(adoBuild.apiBase);
      if (failedLogs) {
        const markdown = `# ${title}\n\n${failedLogs}`;
        const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;
        return { title, url, favicon, markdown, wordCount };
      }
    } catch {
      // Timeline API unavailable/unauthorized — fall through to the normal
      // page-scrape paths below (innerText / raw-log-link / Readability).
    }
  } else {
    // No single buildId in the URL — this is likely the pipeline's Runs
    // history/list page ("#300.14.25-RUN-16 — Failed") rather than one
    // build's results view. Ask the API for the recent failed runs of this
    // pipeline definition directly, and traverse into each one.
    const adoPipeline = findAdoPipelineApiBase();
    if (adoPipeline) {
      try {
        const failedRunsLogs = await fetchAdoRecentFailedRunsLogs(adoPipeline.apiBase, adoPipeline.definitionId);
        if (failedRunsLogs) {
          const markdown = `# ${title}\n\n${failedRunsLogs}`;
          const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;
          return { title, url, favicon, markdown, wordCount };
        }
      } catch {
        // Fall through to the normal page-scrape paths below.
      }
    }
  }

  // ── YOUTUBE TRANSCRIPT EXTRACTION ──
  if (window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch') {
    try {
      // Read the live player response via the background script (MAIN world)
      const ytResponse = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_MAIN_WORLD_YT_RESPONSE' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response?.data || null);
          }
        });
      });

      let transcriptText = '';
      if (ytResponse) {
        try {
          transcriptText = await fetchTimedtextTranscript(ytResponse);
        } catch (e) {
          console.warn('YouTube timedtext fetch failed:', e);
        }
      }

      // Timedtext is empty when YouTube demands a PO token — scrape the
      // transcript panel instead.
      if (!transcriptText.trim()) {
        transcriptText = await scrapeTranscriptPanel();
      }

      if (transcriptText.trim()) {
        title = ytResponse?.videoDetails?.title || title.replace(/ - YouTube$/, '');
        const author = ytResponse?.videoDetails?.author || '';
        const description = (ytResponse?.videoDetails?.shortDescription || '').trim();

        const markdown =
          `# ${title}\n\n` +
          (author ? `**Channel:** ${author}\n\n` : '') +
          (description ? `## Description\n\n${description}\n\n` : '') +
          `## Transcript\n\n${transcriptText}`;
        const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;

        return { title, url, favicon, markdown, wordCount, kind: 'youtube', author };
      }
      console.warn('YouTube transcript: no captions found via timedtext or panel; falling back to page extraction');
    } catch (err) {
      console.error('Failed to extract YouTube transcript:', err);
      // Fallback to standard extraction
    }
  }

  // ── LOG / TECHNICAL PAGE DETECTION ──
  // Pages with high <pre>/<code>/monospace density (CI logs, error pages,
  // Azure DevOps pipelines, stack traces) are poorly served by Readability
  // (which strips structure). Instead, use the raw innerText which preserves
  // line-by-line layout and is 10-100x faster.
  const body = document.body;
  const totalText = body?.innerText || '';
  const preCount = document.querySelectorAll('pre').length;
  const codeCount = document.querySelectorAll('code').length;
  const monospaceDensity = totalText.length > 0
    ? (preCount * 200 + codeCount * 50) / totalText.length
    : 0;
  const isLogPage = monospaceDensity > 0.3 || preCount > 20 || totalText.split('\n').length > 500;

  if (isLogPage) {
    // Prefer the raw-log endpoint over innerText when the page exposes one:
    // it's a plain-text fetch, unaffected by the virtualized log viewer only
    // mounting on-screen rows. Same-origin `fetch` from the content script
    // carries the page's own session cookies, so authenticated CI viewers
    // (Azure DevOps, GitLab, etc.) work the same as a logged-in browser tab.
    const rawLogUrl = findRawLogUrl();
    if (rawLogUrl) {
      try {
        const res = await fetch(rawLogUrl, { credentials: 'include' });
        if (res.ok) {
          const rawText = await res.text();
          // Sanity check: a real raw log should be at least as large as what
          // we already see on-screen — guards against the link resolving to
          // something unrelated (e.g. a login/error page for an expired session).
          if (rawText.trim().length >= totalText.trim().length * 0.5) {
            const wordCount = rawText.split(/\s+/).filter(w => w.length > 0).length;
            return { title, url, favicon, markdown: truncateKeepingTail(rawText, 100000), wordCount };
          }
        }
      } catch {
        // Fall through to the innerText fast path below.
      }
    }
    // Fast path: innerText preserves line structure, good for logs/errors —
    // but only reflects whatever the virtualized viewer currently has mounted.
    const wordCount = totalText.split(/\s+/).filter(w => w.length > 0).length;
    return { title, url, favicon, markdown: truncateKeepingTail(totalText, 100000), wordCount };
  }

  // ── STANDARD PAGE EXTRACTION ──
  const documentClone = document.cloneNode(true) as Document;
  
  // Remove all scripts and styles from the clone to avoid CSP warnings when Readability/Turndown does innerHTML
  const elementsToRemove = documentClone.querySelectorAll('script, noscript, style, link[rel="stylesheet"]');
  elementsToRemove.forEach(el => el.parentNode?.removeChild(el));

  const reader = new Readability(documentClone, {
    keepClasses: true,
  });
  
  const article = reader.parse();

  const htmlContent: string = (article && article.content) ? article.content : document.body.innerHTML;
  title = (article && article.title) ? article.title : title;

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
  });

  let markdown = turndownService.turndown(htmlContent);

  // Clean up excessive newlines
  markdown = markdown.replace(/\n{4,}/g, '\n\n\n').trim();

  // Documentation hubs / TOC pages are mostly links — and Readability often
  // strips nav-style link lists, leaving bare titles with no hrefs. Chat's
  // link-expansion step needs real URLs to follow, so when the page's DOM is
  // link-rich but the extracted markdown is link-poor, append the page's
  // links as a markdown list (ephemeral page-context use, not saved content).
  const mdLinkCount = (markdown.match(/\]\(https?:\/\//g) || []).length;
  if (mdLinkCount < 15) {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 120) continue;
      let abs: string;
      try { abs = new URL(a.getAttribute('href')!, window.location.href).href; } catch { continue; }
      if (!/^https?:\/\//.test(abs) || abs.split('#')[0] === url.split('#')[0]) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      items.push(`- [${text.replace(/[\[\]]/g, '')}](${abs})`);
      if (items.length >= 150) break;
    }
    if (items.length >= 15) {
      markdown += `\n\n## Links on this page\n\n${items.join('\n')}`;
    }
  }

  // Site navigation — ALWAYS harvested, regardless of how link-rich the
  // article is. Readability strips nav/header/footer, so on a link-rich page
  // the <15 rescue above never fires and the site's own nav (Pricing, Docs,
  // Plans…) silently vanishes — which is exactly where chat's link-following
  // needs to hop when the user asks "what does a credit cost" on a page that
  // links to Pricing (observed live: the pricing link never reached the
  // selector). Compact, deduped, capped; ephemeral page-context only.
  {
    const navSeen = new Set<string>(Array.from(markdown.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)).map(m => m[1]));
    const navItems: string[] = [];
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(
      'nav a[href], header a[href], footer a[href], [role="navigation"] a[href]'
    ))) {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 60) continue;
      let abs: string;
      try { abs = new URL(a.getAttribute('href')!, window.location.href).href; } catch { continue; }
      if (!/^https?:\/\//.test(abs) || abs.split('#')[0] === url.split('#')[0]) continue;
      if (navSeen.has(abs)) continue;
      navSeen.add(abs);
      navItems.push(`- [${text.replace(/[\[\]]/g, '')}](${abs})`);
      if (navItems.length >= 40) break;
    }
    if (navItems.length > 0) {
      markdown += `\n\n## Site navigation\n\n${navItems.join('\n')}`;
    }
  }

  // Comments + build info: Readability keeps only the main article, dropping
  // comment threads, asides, and footers — so a question answerable from the
  // discussion or a colophon ("built with X") comes up empty. Recover them
  // from the live DOM. (Cross-origin comment iframes like Disqus can't be read
  // and are silently skipped.)
  const extras: string[] = [];

  const generator = document.querySelector('meta[name="generator"]')?.getAttribute('content')?.trim();
  if (generator) extras.push(`**Site generator:** ${generator}`);

  // Top-level comment/discussion containers only — skip nested items so a
  // container and its children don't both dump the same text.
  const commentSel = '#comments, .comments, #disqus_thread, [id*="comment-list"], [class*="comment-list"], [class*="responses"], [class*="discussion"]';
  const containers: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(commentSel))) {
    if (containers.some(c => c.contains(el))) continue;
    containers.push(el);
  }
  const commentText = containers
    .map(el => (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(t => t.length > 40)
    .join('\n\n---\n\n')
    .slice(0, 3500);
  if (commentText) extras.push(`### Comments / discussion\n\n${commentText}`);

  if (extras.length > 0) {
    markdown += `\n\n## Page extras (comments & build info)\n\n${extras.join('\n\n')}`;
  }

  // Webmail: Readability extracts the OPENED message and drops the inbox list,
  // so "what other messages do I have?" comes up empty. Recover the visible
  // message rows from the DOM (host-gated; ephemeral page context only).
  try {
    const mailbox = extractMailboxList(document, window.location.hostname);
    if (mailbox.length > 0) {
      markdown += `\n\n## Mailbox — messages visible on this page\n\n${mailbox.join('\n')}`;
    }
  } catch { /* extraction is best-effort — never break page capture over it */ }

  // If the title looks like a generic site name (e.g. "Google Gemini"),
  // try to extract a real content title from the first markdown heading.
  if (isGenericTitle(title)) {
    title = extractTitleFromMarkdown(markdown, title);
  }

  const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;

  return { title, url, favicon, markdown, wordCount, kind: 'web' as const, author: (article as any)?.byline || undefined };
}

// ─────────────────────────────────────────────
// Keyboard Shortcuts Listener for Sidepanel & Capture
// ─────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  const code = e.code;
  if (code !== 'KeyM' && code !== 'KeyC') return;

  const activeEl = document.activeElement;
  const isTyping = activeEl && (
    activeEl.tagName === 'INPUT' ||
    activeEl.tagName === 'TEXTAREA' ||
    activeEl.tagName === 'SELECT' ||
    activeEl.hasAttribute('contenteditable') ||
    (activeEl as HTMLElement).isContentEditable
  );
  if (isTyping) return;

  // Toggle Sidepanel: Alt + M (Option + M on Mac)
  if (code === 'KeyM' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'toggle_sidepanel' }).catch(() => {});
  }

  // Instant Capture: Alt + C (Option + C on Mac)
  if (code === 'KeyC' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'capture_current_page_via_hotkey' }).catch(() => {});
  }
}, true);

// ─────────────────────────────────────────────
// On-Page Toast Notification System
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'SHOW_ONPAGE_TOAST') {
    showOnPageToast(request.message, request.isError);
    sendResponse({ success: true });
    return false;
  }
  return false;
});

function showOnPageToast(message: string, isError = false) {
  let container = document.getElementById('magpie-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'magpie-toast-container';
    container.style.position = 'fixed';
    container.style.bottom = '24px';
    container.style.right = '24px';
    container.style.zIndex = '2147483647';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '8px';
    container.style.pointerEvents = 'none';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '10px';
  toast.style.padding = '10px 14px';
  toast.style.borderRadius = '10px';
  toast.style.backgroundColor = isError ? 'rgba(220, 38, 38, 0.95)' : 'rgba(15, 23, 42, 0.95)';
  toast.style.color = '#ffffff';
  toast.style.fontSize = '12px';
  toast.style.fontWeight = '600';
  toast.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  toast.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.15), 0 4px 6px -4px rgba(0, 0, 0, 0.15)';
  toast.style.border = '1px solid rgba(255, 255, 255, 0.1)';
  toast.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
  toast.style.transform = 'translateY(20px)';
  toast.style.opacity = '0';

  const symbol = document.createElement('span');
  symbol.textContent = isError ? '✕' : '✓';
  symbol.style.display = 'inline-flex';
  symbol.style.alignItems = 'center';
  symbol.style.justifyContent = 'center';
  symbol.style.width = '16px';
  symbol.style.height = '16px';
  symbol.style.borderRadius = '50%';
  symbol.style.backgroundColor = isError ? 'rgba(255, 255, 255, 0.2)' : 'rgba(16, 185, 129, 0.2)';
  symbol.style.color = isError ? '#ffffff' : '#10b981';
  symbol.style.fontSize = '9px';
  toast.appendChild(symbol);

  const textNode = document.createElement('span');
  textNode.textContent = message;
  toast.appendChild(textNode);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });

  setTimeout(() => {
    toast.style.transform = 'translateY(-20px)';
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
      if (container && container.childNodes.length === 0) {
        container.remove();
      }
    }, 300);
  }, 3000);
}
