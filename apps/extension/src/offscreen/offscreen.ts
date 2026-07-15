// ─────────────────────────────────────────────
// Offscreen Document — HTML → Markdown parser
// ─────────────────────────────────────────────
// Deep research fetches raw HTML in the service worker (no DOM there),
// then delegates Readability + Turndown parsing to this invisible
// offscreen document. No browser tabs are ever opened.

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
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

const generateEmbeddings = (texts: string[]): Promise<number[][]> => {
  crumb('offscreen', 'embed start', { n: texts.length, chars: texts.reduce((a, t) => a + t.length, 0), heapMB: heapMB() });
  return callWorker<{ embeddings: number[][] }>({ type: 'embed', texts }).then(r => r.embeddings);
};

const rerank = (query: string, passages: string[]): Promise<number[]> => {
  crumb('offscreen', 'rerank start', { n: passages.length });
  return callWorker<{ scores: number[] }>({ type: 'rerank', query, passages }).then(r => r.scores);
};

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Extract text from a PDF using code (pdf.js). For pages that yield little or
 * no text (scanned pages), render the page to a PNG data URL so the caller can
 * OCR it with a vision model — vision is only a fallback.
 */
async function parsePdf(base64: string): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[] }> {
  return parsePdfData(base64ToUint8Array(base64));
}

/**
 * Parse a PDF the sidepanel streamed into OPFS (shared same-origin storage).
 * No base64, no giant sendMessage payload — the bytes never cross a message
 * boundary, which is what let large books crash the renderer. Deletes the
 * OPFS temp file when done (success or failure).
 */
async function parsePdfOpfs(opfsName: string): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[] }> {
  const root = await navigator.storage.getDirectory();
  try {
    const fh = await root.getFileHandle(opfsName);
    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    return await parsePdfData(new Uint8Array(buf));
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
const MAX_PDF_URL_MB = 50;

async function parsePdfUrl(url: string): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[]; bytes: number }> {
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
  const parsed = await parsePdfData(new Uint8Array(buf));
  return { ...parsed, bytes: buf.byteLength };
}

const MAX_PDF_PAGES = 800;

async function parsePdfData(data: Uint8Array): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[] }> {
  // Per-page progress so a long parse is observably alive (not a dead
  // "parsing…"), and so a stall pinpoints where it hangs.
  const postProgress = (pg: number, totalPages: number) => {
    try {
      const ch = new BroadcastChannel('ai_research_assistant_import');
      ch.postMessage({ type: 'pdf-page', page: pg, totalPages });
      ch.close();
    } catch { /* ignore */ }
  };
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages: string[] = [];
  const imagePages: { index: number; dataUrl: string }[] = [];

  const pageLimit = Math.min(pdf.numPages, MAX_PDF_PAGES);
  // Rendering scanned pages for OCR only makes sense for small PDFs — a big
  // book's image-heavy pages are what stalled the parse, and OCR-ing hundreds
  // of pages is infeasible. Big docs extract text only.
  const renderScanned = pageLimit <= 40;
  const MAX_SCANNED_RENDERS = 12;
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

        // A page with almost no extractable text is likely scanned/image →
        // render it to a canvas for the vision model. But this is EXPENSIVE
        // (full-page raster + PNG), and doing it for the image-heavy early
        // pages of a big book (cover, TOC, screenshots) is what stalled the
        // whole parse. So: only render for reasonably small PDFs (OCR-ing
        // hundreds of pages is infeasible anyway), cap the number of renders,
        // and time-guard each one so a slow render can't hang the parse.
        if (rawText.length < 20) {
          pages.push(rawText || `*(page ${p}: image / scanned)*`);
          if (renderScanned && imagePages.length < MAX_SCANNED_RENDERS) {
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const task = page.render({ canvasContext: ctx, viewport, canvas } as any);
              try {
                await Promise.race([
                  task.promise,
                  new Promise((_, rej) => setTimeout(() => rej(new Error('render timeout')), 15000)),
                ]);
                imagePages.push({ index: p, dataUrl: canvas.toDataURL('image/png') });
              } catch {
                try { task.cancel(); } catch { /* ignore */ }
              } finally {
                // Free the canvas backing store immediately — a scale-2 full-page
                // raster is multi-MB, and letting a dozen linger balloons the
                // offscreen heap. Zeroing the dimensions releases the pixel buffer.
                canvas.width = 0; canvas.height = 0;
              }
            }
          }
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
        if (p % 10 === 0 || p === pageLimit) { postProgress(p, pageLimit); await new Promise(r => setTimeout(r, 0)); }
      }
    }
    return { pages, imagePages };
  } finally {
    // Document-level cleanup (frees @font-face / shared resources pdf.js caches
    // across pages) BEFORE destroy — page.cleanup() alone leaves these behind.
    try { await (pdf as any).cleanup?.(); } catch { /* ignore */ }
    await pdf.destroy().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === 'OFFSCREEN_PARSE_PDF') {
    crumb('offscreen', 'pdf parse (base64) start', { base64Mb: Math.round((request.base64 as string || '').length / 1.33 / 1024 / 1024) });
    parsePdf(request.base64 as string)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_PARSE_PDF_URL') {
    parsePdfUrl(request.url as string)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_PARSE_PDF_OPFS') {
    parsePdfOpfs(request.opfsName as string)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (request?.action === 'OFFSCREEN_PARSE_HTML') {
    try {
      const { html: rawHtml, url } = request as { html: string; url: string };
      // A giant scraped page (some sites serve multi-MB HTML) expands to 5–10× in
      // the DOM that DOMParser + Readability build on this main thread — big
      // enough to OOM/crash the offscreen renderer mid-research. 3 MB is ample for
      // article extraction; truncate the tail (boilerplate/comments) rather than
      // risk the whole run.
      const MAX_HTML = 3_000_000;
      let html = rawHtml.length > MAX_HTML ? rawHtml.slice(0, MAX_HTML) : rawHtml;

      // Strip <script>/<link>/<style> from the RAW STRING before DOMParser. These
      // never execute in a DOMParser doc (no browsing context), BUT Chrome still
      // fires a CSP "Loading the script … has been blocked" console violation for
      // each <script src> element the moment parseFromString creates it — noisy
      // when a scraped page (e.g. a Cloudflare bot-check) is script-heavy. Removing
      // them from the string means the elements are never created, so no report.
      html = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<script\b[^>]*\/?>/gi, '')
        .replace(/<link\b[^>]*>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

      const parsed = new DOMParser().parseFromString(html, 'text/html');

      // Belt-and-suspenders: drop any residual resource-referencing nodes before
      // Readability/Turndown touch innerHTML.
      parsed.querySelectorAll('script, noscript, style, link, iframe, object, embed')
        .forEach(el => el.parentNode?.removeChild(el));

      // Resolve relative URLs against the source page
      const base = parsed.createElement('base');
      base.href = url;
      parsed.head?.prepend(base);

      const reader = new Readability(parsed, { keepClasses: true });
      const article = reader.parse();

      const htmlContent: string = article?.content || parsed.body?.innerHTML || '';
      const title: string = article?.title || parsed.title || 'Untitled';

      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
      });

      let markdown = turndown.turndown(htmlContent);
      markdown = markdown.replace(/\n{4,}/g, '\n\n\n').trim();

      const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;

      // Help V8 reclaim the (up to 3 MB) parsed DOM promptly. This offscreen
      // parses hundreds of pages per run and its main-thread heap climbs toward an
      // OOM that no mid-run recreate/worker-recycle can free; emptying the parsed
      // document breaks the largest retained graph so GC can drop it sooner.
      try { parsed.documentElement.innerHTML = ''; } catch { /* ignore */ }

      sendResponse({ ok: true, title, markdown, wordCount });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (request?.action === 'OFFSCREEN_GET_EMBEDDINGS') {
    generateEmbeddings(request.texts as string[])
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

  return false;
});

// Model preload now happens inside the inference worker (see its `init`
// handler), fired by the postMessage above on document creation.
