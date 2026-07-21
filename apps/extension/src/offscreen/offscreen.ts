// ─────────────────────────────────────────────
// Offscreen Document — HTML → Markdown parser
// ─────────────────────────────────────────────
// Deep research fetches raw HTML in the service worker (no DOM there),
// then delegates Readability + Turndown parsing to this invisible
// offscreen document. No browser tabs are ever opened.

import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this to a bundled worker file URL.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildPageMarkdown, TextBlock } from '../lib/pdf-layout';
import { crumb, installCrashHandlers } from '../lib/crash-log';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
installCrashHandlers('offscreen');

// ── Inference worker proxy ──
// Embeddings + re-ranking run in a dedicated Worker so their ONNX inference
// never blocks this document's main thread. The offscreen doc shares a renderer
// process with the sidepanel, so inline inference here froze the chat UI for the
// whole embed/rerank; the worker keeps that main thread free. `chrome.*` isn't
// available inside a Worker, so we hand it the WASM base URL on init.
// Embedder device is user-selectable (Settings → Inference acceleration); default
// WASM for stability (WebGPU can silently OOM the renderer on heavy runs). The
// Worker can't read chrome.storage, so we read it here and hand it over on init,
// and push changes live via set_device.
let workerDevice: 'wasm' | 'webgpu' = 'wasm';
let workerReqSeq = 0;
const workerPending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// The Worker is RESPAWNABLE. If it ever dies (a WASM OOM can crash just the
// worker thread), a `const` worker would be dead forever: every later embed/
// rerank posts into the void and hangs 45s → the whole offscreen queue stalls
// for minutes, which looks exactly like a frozen/crashed extension. Instead we
// reject in-flight calls and spawn a fresh worker so the next call self-heals.
let inferenceWorker: Worker;
let respawns = 0;
let respawnWindowStart = Date.now();
function spawnInferenceWorker(): void {
  inferenceWorker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
  inferenceWorker.postMessage({ type: 'init', wasmPaths: chrome.runtime.getURL('transformers/'), device: workerDevice });
  inferenceWorker.onmessage = (e: MessageEvent<any>) => {
    const { id, ok, error, ...rest } = e.data || {};
    const p = workerPending.get(id);
    if (!p) return;
    workerPending.delete(id);
    ok ? p.resolve(rest) : p.reject(new Error(error || 'inference worker error'));
  };
  inferenceWorker.onerror = (e) => {
    console.warn('[offscreen] inference worker crashed:', e.message);
    crumb('offscreen', 'inference worker crashed', e.message || 'unknown');
    for (const [, p] of workerPending) p.reject(new Error(e.message || 'inference worker crashed'));
    workerPending.clear();
    try { inferenceWorker.terminate(); } catch { /* already gone */ }
    // Cap respawns so a worker that crashes on init can't storm-loop.
    if (Date.now() - respawnWindowStart > 60_000) { respawns = 0; respawnWindowStart = Date.now(); }
    if (++respawns <= 5) spawnInferenceWorker();
    else console.error('[offscreen] inference worker crashed too many times — giving up until reload');
  };
}
spawnInferenceWorker();

// ── HTML parse worker proxy ──
// HTML→Markdown extraction (DOMParser + Readability + Turndown) runs in ITS OWN
// worker isolate so the ~40-90 MB DOM it builds per page never touches this main
// thread's heap — which is the isolate that climbed to the V8 cap and OOM-crashed
// the renderer. Recycled every N parses to reset its isolate (cheap — no model to
// reload, unlike the inference worker). See parse.worker.ts.
let parseWorker: Worker;
let parseReqSeq = 0;
const parsePending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let parseCount = 0;
const PARSE_RECYCLE_EVERY = 5;
let parseRespawns = 0;
let parseRespawnWindowStart = Date.now();

function spawnParseWorker(): void {
  parseWorker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
  parseWorker.onmessage = (e: MessageEvent<any>) => {
    const { id, ok, error, ...rest } = e.data || {};
    const p = parsePending.get(id);
    if (!p) return;
    parsePending.delete(id);
    ok ? p.resolve(rest) : p.reject(new Error(error || 'parse worker error'));
  };
  parseWorker.onerror = (e) => {
    crumb('offscreen', 'parse worker crashed', e.message || 'unknown');
    for (const [, p] of parsePending) p.reject(new Error(e.message || 'parse worker crashed'));
    parsePending.clear();
    try { parseWorker.terminate(); } catch { /* already gone */ }
    if (Date.now() - parseRespawnWindowStart > 60_000) { parseRespawns = 0; parseRespawnWindowStart = Date.now(); }
    if (++parseRespawns <= 5) spawnParseWorker();
  };
}
spawnParseWorker();

const PARSE_CALL_TIMEOUT_MS = 30_000;
function callParseWorker<T>(html: string, url: string): Promise<T> {
  const id = ++parseReqSeq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (parsePending.delete(id)) reject(new Error('parse worker timed out'));
    }, PARSE_CALL_TIMEOUT_MS);
    parsePending.set(id, {
      resolve: (v: any) => { clearTimeout(timer); resolve(v); },
      reject: (e: any) => { clearTimeout(timer); reject(e); },
    });
    parseWorker.postMessage({ type: 'parse', id, html, url });
  });
}

/** Reset the parse worker's isolate heap every N parses (cheap — no model). */
function maybeRecycleParseWorker(): void {
  if (++parseCount % PARSE_RECYCLE_EVERY === 0) {
    try { parseWorker.terminate(); } catch { /* ignore */ }
    spawnParseWorker();
    crumb('offscreen', 'parse worker recycled', { after: parseCount });
  }
}

/**
 * Cheap main-thread pre-processing done on the STRING (no DOM) before the HTML is
 * handed to the parse worker: cap the size, and strip the elements that either bloat
 * the DOM or trigger Chrome resource/CSP loads. Kept on the main thread precisely
 * because it's string-only (no heap-heavy DOM) — and it shrinks the payload copied
 * to the worker.
 */
function prestripHtml(rawHtml: string): string {
  // A giant scraped page (multi-MB HTML) expands 5–10× as a DOM; 3 MB is ample for
  // article extraction, so truncate the boilerplate tail.
  const MAX_HTML = 3_000_000;
  const html = rawHtml.length > MAX_HTML ? rawHtml.slice(0, MAX_HTML) : rawHtml;
  // <script>/<link>/<style> would make Chrome fire CSP "script blocked" + preload
  // fetches even in a DOMParser doc; <svg> sprites/<template>/comments just bloat.
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * DOM-free HTML→text fallback — used ONLY when the parse worker fails. We
 * DELIBERATELY do NOT re-parse a full DOM (DOMParser + Readability) on this main
 * thread here: that is the exact ~500-850 MB/page heap spike the worker exists to
 * avoid, and with the between-stage recreate unable to free it (Chrome pools the
 * renderer) it ratchets to an OOM. Crude string extraction instead — strip
 * non-content elements + tags, decode common entities, collapse whitespace. Lower
 * quality (no article detection), but it's string-only: zero DOM, zero heap spike.
 * These are the minority of pages the jina reader couldn't turn into markdown.
 */
function cheapHtmlToText(html: string, url: string): { title: string; markdown: string; wordCount: number } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url).replace(/\s+/g, ' ').trim();
  const markdown = html
    .replace(/<(script|style|nav|footer|header|aside|svg|head|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
    .slice(0, 30000); // cap — low-value pages, don't feed the index a huge blob
  return { title, markdown, wordCount: markdown.split(/\s+/).filter(Boolean).length };
}

// IMPORTANT: an offscreen document exposes ONLY chrome.runtime — chrome.storage
// is undefined here, and reading it at top level throws and kills the whole doc
// (embeds/rerank/PDF parse all die). So we ask the service worker (which DOES
// have storage) for the device pref, and it pushes live changes to us via a
// SET_INFERENCE_DEVICE message (handled below).
chrome.runtime.sendMessage({ action: 'GET_INFERENCE_DEVICE' }).then((r: any) => {
  if (r?.device === 'webgpu') { workerDevice = 'webgpu'; inferenceWorker.postMessage({ type: 'set_device', device: 'webgpu' }); }
}).catch(() => { /* SW not ready or no handler — stay on the wasm default */ });

const WORKER_CALL_TIMEOUT_MS = 45_000;
function callWorker<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++workerReqSeq;
  return new Promise<T>((resolve, reject) => {
    // A stuck model load / inference must not hang the caller forever — bound it.
    const timer = setTimeout(() => {
      if (workerPending.delete(id)) reject(new Error('inference worker timed out'));
    }, WORKER_CALL_TIMEOUT_MS);
    workerPending.set(id, {
      resolve: (v: any) => { clearTimeout(timer); resolve(v); },
      reject: (e: any) => { clearTimeout(timer); reject(e); },
    });
    inferenceWorker.postMessage({ id, ...msg });
  });
}

// JS heap of THIS renderer (offscreen doc — Chrome-only API). It does NOT include
// the inference worker's WASM linear memory, but a climbing value still points at
// JS-side accumulation in the renderer (panel + offscreen share a process).
const heapMB = (): number | undefined => {
  try { const m = (performance as any).memory; return m ? Math.round(m.usedJSHeapSize / 1048576) : undefined; }
  catch { return undefined; }
};

const generateEmbeddings = (texts: string[], kind?: 'query' | 'passage'): Promise<number[][]> => {
  crumb('offscreen', 'embed start', { n: texts.length, chars: texts.reduce((a, t) => a + t.length, 0), heapMB: heapMB() });
  return callWorker<{ embeddings: number[][] }>({ type: 'embed', texts, kind }).then(r => r.embeddings);
};

const rerank = (query: string, passages: string[]): Promise<number[]> => {
  crumb('offscreen', 'rerank start', { n: passages.length });
  return callWorker<{ scores: number[] }>({ type: 'rerank', query, passages }).then(r => r.scores);
};

interface NliResult {
  entailment: number;
  neutral: number;
  contradiction: number;
}

const classifyNli = (pairs: { premise: string; claim: string }[]): Promise<NliResult[]> => {
  crumb('offscreen', 'nli start', { n: pairs.length });
  return callWorker<{ results: NliResult[] }>({ type: 'nli', pairs }).then(r => r.results);
};

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Embedded PDF image extraction ──
// Figures are extracted AS IMAGES (not OCR'd, not dropped): the vision model
// stays an opt-in fallback for genuinely scanned pages. Images travel back as
// PNG data URLs (bounded: ≤40/doc, ≤1.5 MB each, ≥64×64 px, hash-deduped) and
// are stored as IDB blobs by the caller; the markdown references them via
// `magpie-img://p{page}.{n}` refs the viewer resolves.
export interface EmbeddedImage {
  imgId: string;     // doc-relative id, e.g. "p3.1"
  page: number;
  dataUrl: string;
  width: number;
  height: number;
}

const MAX_DOC_IMAGES = 20;
const MAX_IMAGE_DATAURL = 700_000;   // ~500 KB binary
const MIN_IMAGE_DIM = 64;

function imageToPngDataUrl(img: any): { dataUrl: string; width: number; height: number } | null {
  try {
    let width = 0, height = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
      width = img.width; height = img.height;
      canvas.width = width; canvas.height = height;
      ctx.drawImage(img, 0, 0);
    } else if (img && typeof img.width === 'number' && typeof img.height === 'number' && img.data) {
      width = img.width; height = img.height;
      canvas.width = width; canvas.height = height;
      // pdf.js raw images: kind 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP
      if (img.kind === 3 || !img.kind) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer ? img.data : img.data.slice(0)), width, height), 0, 0);
      } else if (img.kind === 2) {
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let s = 0, d = 0; s < img.data.length; s += 3, d += 4) {
          rgba[d] = img.data[s]; rgba[d + 1] = img.data[s + 1]; rgba[d + 2] = img.data[s + 2]; rgba[d + 3] = 255;
        }
        ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
      } else {
        return null; // 1bpp grayscale — rare, skip
      }
    } else {
      return null;
    }
    if (width < MIN_IMAGE_DIM || height < MIN_IMAGE_DIM) return null; // icons/rules/bullets
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > MAX_IMAGE_DATAURL) return null; // huge figure — skip rather than blow the message cap
    return { dataUrl, width, height };
  } catch {
    return null;
  }
}

async function extractEmbeddedImages(page: any, pageNum: number, budget: number, seenHashes: Set<string>): Promise<EmbeddedImage[]> {
  const out: EmbeddedImage[] = [];
  if (budget <= 0) return out;
  try {
    const ops = await page.getOperatorList();
    const OPS = (pdfjsLib as any).OPS;
    let n = 0;
    for (let i = 0; i < ops.fnArray.length && out.length < budget; i++) {
      const fn = ops.fnArray[i];
      if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject && fn !== OPS.paintImageXObjectRepeat) continue;
      const arg = ops.argsArray[i]?.[0];
      try {
        let img: any = null;
        if (fn === OPS.paintInlineImageXObject) {
          img = arg; // inline images carry their data in the arg itself
        } else if (typeof arg === 'string') {
          img = await new Promise<any>(res => {
            try { page.objs.get(arg, res); } catch { res(null); }
            setTimeout(() => res(null), 3000);
          });
        }
        if (!img) continue;
        // paintImageXObjectRepeat paints the same image at several positions —
        // store it once (dedupe below also catches repeats across pages).
        const conv = imageToPngDataUrl(img);
        if (!conv) continue;
        // Cheap dedupe hash: size + sampled bytes (logos repeat across pages).
        const s = conv.dataUrl;
        const hash = `${s.length}:${s.slice(100, 140)}${s.slice(-60)}`;
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        out.push({ imgId: `p${pageNum}.${++n}`, page: pageNum, ...conv });
      } catch { /* one bad image never fails the page */ }
    }
  } catch { /* operator list unavailable — text-only page */ }
  return out;
}

/**
 * Extract text from a PDF using code (pdf.js). For pages that yield little or
 * no text (scanned pages), render the page to a PNG data URL so the caller can
 * OCR it with a vision model — vision is only a fallback.
 */
async function parsePdf(base64: string, silent?: boolean): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[]; images: EmbeddedImage[] }> {
  return parsePdfData(base64ToUint8Array(base64), silent);
}

/**
 * Parse a PDF the sidepanel streamed into OPFS (shared same-origin storage).
 * No base64, no giant sendMessage payload — the bytes never cross a message
 * boundary, which is what let large books crash the renderer. Deletes the
 * OPFS temp file when done (success or failure).
 */
async function parsePdfOpfs(opfsName: string, silent?: boolean): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[]; images: EmbeddedImage[] }> {
  const root = await navigator.storage.getDirectory();
  try {
    const fh = await root.getFileHandle(opfsName);
    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    return await parsePdfData(new Uint8Array(buf), silent);
  } finally {
    await root.removeEntry(opfsName).catch(() => {});
  }
}

/**
 * Fetch a PDF URL and parse it — entirely inside the offscreen document so
 * multi-MB PDFs never travel through chrome.runtime.sendMessage (which has a
 * ~64 MB cap and OOMs the worker when base64-encoding large buffers). The
 * timeout scales with an initial HEAD size probe.
 */
// A research run auto-ingests PDFs from the open web — a huge one (whole
// proceedings, a scanned book) buffers entirely in memory here and, with pdf.js
// structures on top, can OOM the offscreen renderer. Cap it: skip oversize PDFs
// (the run continues with its other sources) rather than risk the whole process.
const MAX_PDF_URL_MB = 30;

async function parsePdfUrl(url: string, silent?: boolean): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[]; images: EmbeddedImage[]; bytes: number }> {
  let sizeMb = 0;
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const len = Number(head.headers.get('content-length') || 0);
    if (len > 0) sizeMb = len / (1024 * 1024);
  } catch { /* size probe optional */ }
  if (sizeMb > MAX_PDF_URL_MB) throw new Error(`PDF too large to parse safely (${Math.round(sizeMb)} MB)`);
  crumb('offscreen', 'pdf parse start', { url: url.slice(0, 120), sizeMb: Math.round(sizeMb) });
  // 30s floor + 3s per MB, capped at 5 min
  const timeoutMs = Math.min(300000, 30000 + Math.ceil(sizeMb) * 3000);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`PDF fetch failed: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // HEAD may lie / be absent — enforce the cap on the real byte length too.
  if (buf.byteLength > MAX_PDF_URL_MB * 1024 * 1024) {
    throw new Error(`PDF too large to parse safely (${Math.round(buf.byteLength / 1024 / 1024)} MB)`);
  }
  const parsed = await parsePdfData(new Uint8Array(buf), silent);
  return { ...parsed, bytes: buf.byteLength };
}

const MAX_PDF_PAGES = 800;

async function parsePdfData(data: Uint8Array, silent?: boolean): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[]; images: EmbeddedImage[] }> {
  // Per-page progress so a long parse is observably alive (not a dead
  // "parsing…"), and so a stall pinpoints where it hangs.
  const postProgress = (pg: number, totalPages: number) => {
    lastActivity = Date.now(); // a long parse is ACTIVITY — keep the idle watchdog off
    if (silent) return;
    try {
      const ch = new BroadcastChannel('ai_research_assistant_import');
      ch.postMessage({ type: 'pdf-page', page: pg, totalPages });
      ch.close();
    } catch { /* ignore */ }
  };
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages: string[] = [];
  const imagePages: { index: number; dataUrl: string }[] = [];
  const images: EmbeddedImage[] = [];
  const seenImageHashes = new Set<string>();

  const pageLimit = Math.min(pdf.numPages, MAX_PDF_PAGES);
  // Scanned-page OCR rendering is disabled — image-only pages get a placeholder.
  postProgress(0, pageLimit);   // document opened — parse begins
  try {
    for (let p = 1; p <= pageLimit; p++) {
      const page = await pdf.getPage(p);
      try {
        const content = await page.getTextContent();

        const items: TextBlock[] = content.items
          .filter((it: any) => 'str' in it && 'transform' in it)
          .map((it: any) => {
            const transform = it.transform;
            const fontSize = Math.abs(transform[3]);
            return {
              text: it.str,
              x: transform[4],
              y: transform[5],
              width: typeof it.width === 'number' ? it.width : 0,
              fontSize
            };
          });

        const rawText = items.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();

        // Embedded figures: extract as-is on EVERY text page (scanned-page
        // rasterization below is the separate, OCR-only path).
        if (images.length < MAX_DOC_IMAGES) {
          const found = await extractEmbeddedImages(page, p, MAX_DOC_IMAGES - images.length, seenImageHashes);
          images.push(...found);
        }

        // A page with almost no extractable text is likely scanned/image →
        // render it to a canvas for the vision model. But this is EXPENSIVE
        // (full-page raster + PNG), and doing it for the image-heavy early
        // pages of a big book (cover, TOC, screenshots) is what stalled the
        // whole parse. Scanned-page OCR rendering is disabled — image-only
        // pages get a placeholder marker instead.
        if (rawText.length < 20) {
          pages.push(rawText || `*(page ${p}: image / scanned)*`);
          continue;
        }

        // Reconstruct readable markdown from positioned runs (headings, two-column
        // handling, citation fixup, cleanup). Pure + shared with tests/harness.
        const pageWidth = page.getViewport({ scale: 1 }).width;
        pages.push(buildPageMarkdown(items, pageWidth));
      } finally {
        // CRITICAL for large PDFs: free each page's operator list / fonts as we
        // go. Without this, a 470-page book accumulates every page's resources
        // in the offscreen doc → memory thrash / OOM → the parse hangs and the
        // whole import silently times out. Also yield periodically so the
        // offscreen event loop (and the worker keep-alive) stays responsive.
        page.cleanup();
        if (typeof (page as any).destroy === 'function') (page as any).destroy();
        if (p % 10 === 0 || p === pageLimit) { postProgress(p, pageLimit); await new Promise(r => setTimeout(r, 0)); }
      }
    }
    return { pages, imagePages, images };
  } finally {
    // Document-level cleanup (frees @font-face / shared resources pdf.js caches
    // across pages) BEFORE destroy — page.cleanup() alone leaves these behind.
    try { await (pdf as any).cleanup?.(); } catch { /* ignore */ }
    await pdf.destroy().catch(() => {});
  }
}

// Idle watchdog. Chrome NEVER reclaims the offscreen renderer on its own (a
// non-audio reason means unbounded lifetime), so once a run finishes the doc sits
// open holding its whole ~1-2 GB parse heap indefinitely — and the NEXT run
// inherits that hot renderer (the "stage 1 starts at 2.5 GB" crash). Closing the
// doc after a stretch of no messages frees the renderer; the next embed/parse
// rebuilds it fresh (ensureOffscreen re-checks hasDocument; model reloads from
// cache in a few seconds). 90 s so a genuine mid-run lull — e.g. a long LLM
// synthesis with no offscreen traffic — doesn't trip it.
//
// BUSY GUARD: a long PDF parse (8–25 min) holds the SW-side offscreen mutex,
// so no message arrives during it and `lastActivity` goes stale — closing the
// doc mid-parse kills the import the caller budgeted 25 min for. Never close
// while a handler is in flight; parse progress also refreshes `lastActivity`.
let lastActivity = Date.now();
let inFlight = 0;
const IDLE_CLOSE_MS = 60_000;
setInterval(() => {
  if (inFlight > 0) return; // busy — closing now would kill in-flight work
  if (Date.now() - lastActivity >= IDLE_CLOSE_MS) {
    try { crumb('offscreen', 'idle close — freeing renderer', {}); } catch { /* ignore */ }
    try { window.close(); } catch { /* ignore */ }
  }
}, 30_000);

chrome.runtime.onMessage.addListener((request, _sender, rawSendResponse) => {
  lastActivity = Date.now();
  inFlight++;
  let responded = false;
  const sendResponse = (v?: any) => {
    if (!responded) { responded = true; inFlight--; }
    rawSendResponse(v);
  };
  if (request?.action === 'OFFSCREEN_PARSE_PDF') {
    crumb('offscreen', 'pdf parse (base64) start', { base64Mb: Math.round((request.base64 as string || '').length / 1.33 / 1024 / 1024) });
    parsePdf(request.base64 as string, !!request.silent)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_PARSE_PDF_URL') {
    parsePdfUrl(request.url as string, !!request.silent)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_PARSE_PDF_OPFS') {
    parsePdfOpfs(request.opfsName as string, !!request.silent)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_PARSE_HTML') {
    const { html: rawHtml, url } = request as { html: string; url: string };
    // Diagnostic: which URLs actually reach the HTML parser. If a dl.acm.org/etc.
    // Cloudflare page ever shows here, the scrapeUrl fast-path was bypassed — but on
    // this build it shouldn't, and parsing is linkedom-in-worker + pre-stripped, so
    // no <script>/<link> ever reaches a browser DOMParser (no CSP/preload spam).
    crumb('offscreen', 'parse html', { url: url.slice(0, 70) });
    // Cheap string-only pre-processing stays on the main thread; the heap-heavy DOM
    // build (DOMParser + Readability + Turndown) runs in the parse WORKER isolate so
    // it can't grow this main isolate toward its V8-cap OOM. Fall back to an inline
    // parse only if the worker errors/times out, so a hiccup never drops a source.
    const html = prestripHtml(rawHtml);
    callParseWorker<{ title: string; markdown: string; wordCount: number }>(html, url)
      .then(res => { maybeRecycleParseWorker(); sendResponse({ ok: true, ...res }); })
      .catch((err) => {
        // Capture WHY the worker failed — linkedom-in-worker is env-specific and
        // works in Node, so the real error is the only way to fix it properly.
        crumb('offscreen', 'parse worker failed → cheap extract', {
          url: url.slice(0, 70),
          err: String(err?.message || err).slice(0, 140),
        });
        sendResponse({ ok: true, ...cheapHtmlToText(html, url) });
      });
    return true;
  }

  if (request?.action === 'OFFSCREEN_GET_EMBEDDINGS') {
    generateEmbeddings(request.texts as string[], request.kind as 'query' | 'passage' | undefined)
      .then(embeddings => sendResponse({ ok: true, embeddings }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_RERANK') {
    rerank(request.query as string, request.passages as string[])
      .then(scores => sendResponse({ ok: true, scores }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_NLI') {
    classifyNli(request.pairs as { premise: string; claim: string }[])
      .then(results => sendResponse({ ok: true, results }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_HEALTH_CHECK') {
    sendResponse({ ok: true, status: 'healthy' });
    return true;
  }

  // Report the renderer main-thread heap so the SW can decide whether a stage
  // boundary needs a hard reset (chrome.runtime.reload) vs a cheap recreate.
  if (request?.action === 'OFFSCREEN_GET_HEAP') {
    sendResponse({ ok: true, heapMB: heapMB() });
    return true;
  }

  // Service worker pushes device changes here (we can't watch chrome.storage).
  if (request?.action === 'SET_INFERENCE_DEVICE') {
    workerDevice = request.device === 'webgpu' ? 'webgpu' : 'wasm';
    inferenceWorker.postMessage({ type: 'set_device', device: workerDevice });
    sendResponse({ ok: true });
    return true;
  }

  // Reclaim the inference worker's accumulated ONNX/WASM heap. The WASM heap only
  // ever GROWS (~100 MB per embedded source, never shrinks), so over a long stage
  // the renderer OOMs. closeDocument() from the SW doesn't reliably free it
  // mid-run; terminate()-ing the worker and respawning a fresh one does. The SW
  // sends this between sources when the worker is idle (no embed in flight).
  if (request?.action === 'OFFSCREEN_RECYCLE_WORKER') {
    const beforeMB = heapMB();
    for (const [, p] of workerPending) p.reject(new Error('worker recycled for memory'));
    workerPending.clear();
    try { inferenceWorker.terminate(); } catch { /* already gone */ }
    spawnInferenceWorker();
    crumb('offscreen', 'worker recycled', { beforeMB });
    sendResponse({ ok: true });
    return true;
  }

  inFlight--; // unknown action — no response will be sent
  return false;
});

// Model preload now happens inside the inference worker (see its `init`
// handler), fired by the postMessage above on document creation.
