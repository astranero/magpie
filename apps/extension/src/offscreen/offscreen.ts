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
import { env, pipeline, AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';
import { buildPageMarkdown, TextBlock } from '../lib/pdf-layout';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Setup local WASM paths for Chrome Extensions
if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('transformers/');
  }
  env.allowLocalModels = false;
}

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
async function parsePdfUrl(url: string): Promise<{ pages: string[]; imagePages: { index: number; dataUrl: string }[]; bytes: number }> {
  let sizeMb = 0;
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const len = Number(head.headers.get('content-length') || 0);
    if (len > 0) sizeMb = len / (1024 * 1024);
  } catch { /* size probe optional */ }
  // 30s floor + 3s per MB, capped at 5 min
  const timeoutMs = Math.min(300000, 30000 + Math.ceil(sizeMb) * 3000);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`PDF fetch failed: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
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
    await pdf.destroy().catch(() => {});
  }
}

// ── Embeddings and Re-ranking helpers ──

let embedder: any = null;
async function getEmbedder() {
  if (!embedder) {
    // Xenova mirror: onnx-community/all-MiniLM-L6-v2 went 401 (gated) on HF
    // in mid-2026. Same base model + ONNX export, embeddings stay compatible.
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      device: 'webgpu',
    });
  }
  return embedder;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const extractor = await getEmbedder();
  if (texts.length === 0) return [];
  
  // Peak ONNX memory per batch ≈ batch_size × LONGEST-sequence length (every
  // text is padded to the max), so 256 was no limit at all — one long chunk
  // in a big batch still blew the WASM heap (std::bad_alloc from OrtRun).
  // 8 bounds peak allocation regardless of document size; throughput loss is
  // negligible next to model inference time.
  const MAX_BATCH_SIZE = 8;
  
  const processBatch = async (batchTexts: string[]): Promise<number[][]> => {
    try {
      const output = await extractor(batchTexts, { pooling: 'mean', normalize: true });
      const data = output.data as Float32Array;
      const dim = output.dims?.[1] ?? (data.length / batchTexts.length);
      
      // validate dimensions to prevent integer overflow
      if (!dim || !Number.isFinite(dim) || dim <= 0 || dim > 1024) {
        throw new Error(`Invalid embedding dimension: ${dim}`);
      }
      
      // calculate expected data length with overflow protection
      const expectedDataLength = Math.ceil(batchTexts.length * dim);
      if (data.length !== expectedDataLength && data.length % batchTexts.length !== 0) {
        throw new Error(`Data length mismatch: got ${data.length}, expected ${expectedDataLength}`);
      }
      
      const embeddings: number[][] = [];
      for (let i = 0; i < batchTexts.length; i++) {
        const start = i * dim;
        const end = start + dim;
        
        // bounds check to prevent overflow errors
        if (start >= data.length || end > data.length) {
          throw new Error(`Index out of bounds: start=${start}, end=${end}, length=${data.length}`);
        }
        
        embeddings.push(Array.from(data.slice(start, end)));
      }
      return embeddings;
    } catch (batchErr) {
      // fall back to sequential if batched call isn't supported for this model or fails
      if (batchErr instanceof Error && batchErr.message.includes('Integer overflow')) {
        console.warn('Batched embedding failed due to integer overflow, falling back to sequential:', batchErr);
      } else {
        console.warn('Batched embedding failed, falling back to sequential:', batchErr);
      }
      
      const embeddings: number[][] = [];
      for (const text of batchTexts) {
        try {
          const output = await extractor(text, { pooling: 'mean', normalize: true });
          embeddings.push(Array.from(output.data as Float32Array));
        } catch (e) {
          console.error('Failed to generate embedding for text:', text, e);
          embeddings.push(new Array(384).fill(0)); // default dimension from model
        }
      }
      return embeddings;
    }
  };
  
  // split into safe batches to avoid integer overflow
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchEmbeddings = await processBatch(batch);
    embeddings.push(...batchEmbeddings);
  }
  
  return embeddings;
}

let tokenizer: any = null;
let rerankerModel: any = null;
async function getReranker() {
  if (!tokenizer || !rerankerModel) {
    const model_id = 'Xenova/ms-marco-MiniLM-L-6-v2';
    tokenizer = await AutoTokenizer.from_pretrained(model_id);
    rerankerModel = await AutoModelForSequenceClassification.from_pretrained(model_id);
  }
  return { tokenizer, model: rerankerModel };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

async function rerank(query: string, passages: string[]): Promise<number[]> {
  const { tokenizer, model } = await getReranker();
  const scores: number[] = [];

  const inputs = await tokenizer(Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
  });

  const { logits } = await model(inputs);
  const data = logits.data as Float32Array;
  for (let i = 0; i < passages.length; i++) {
    scores.push(sigmoid(data[i]));
  }
  return scores;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === 'OFFSCREEN_PARSE_PDF') {
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
      const { html, url } = request as { html: string; url: string };

      const parsed = new DOMParser().parseFromString(html, 'text/html');

      // Strip scripts/styles to avoid CSP issues when Readability/Turndown
      // touches innerHTML (see project CSP guidelines).
      parsed.querySelectorAll('script, noscript, style, link[rel="stylesheet"]')
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

  return false;
});

// F6: fire-and-forget preload of transformer models on offscreen doc creation.
// Fetches ~30-100MB of weights in the background so the first search / capture
// doesn't stall the message channel waiting for model init.
Promise.all([
  getEmbedder().catch(err => console.warn('[preload] embedder failed:', err)),
  getReranker().catch(err => console.warn('[preload] reranker failed:', err))
]).then(() => console.log('[preload] transformer models ready'));
