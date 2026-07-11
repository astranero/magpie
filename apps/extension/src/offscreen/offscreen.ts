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
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages: string[] = [];
  const imagePages: { index: number; dataUrl: string }[] = [];

  const pageLimit = Math.min(pdf.numPages, MAX_PDF_PAGES);
  for (let p = 1; p <= pageLimit; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    
    interface TextBlock {
      text: string;
      x: number;
      y: number;
      width: number;
      fontSize: number;
    }

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

    // If a page has almost no extractable text, it's likely scanned → render it.
    if (rawText.length < 20) {
      pages.push(rawText);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
        imagePages.push({ index: p, dataUrl: canvas.toDataURL('image/png') });
      }
      continue;
    }

    // Heuristic layout reconstruction
    const fontSizes = items.map(it => it.fontSize).sort((a, b) => a - b);
    const medianFontSize = fontSizes.length > 0 ? fontSizes[Math.floor(fontSizes.length / 2)] : 10;

    interface Line {
      y: number;
      x: number;
      text: string;
      fontSize: number;
    }

    const buildLines = (bucket: TextBlock[]): Line[] => {
      const out: Line[] = [];
      let current: TextBlock[] = [];
      const flush = () => {
        if (current.length === 0) return;
        current.sort((a, b) => a.x - b.x);
        const lineText = current.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
        if (lineText) {
          out.push({
            y: current[0].y,
            x: current[0].x,
            text: lineText,
            fontSize: Math.max(...current.map(it => it.fontSize))
          });
        }
        current = [];
      };
      for (const item of [...bucket].sort((a, b) => b.y - a.y)) {
        if (current.length > 0 && Math.abs(item.y - current[current.length - 1].y) >= 3) flush();
        current.push(item);
      }
      flush();
      return out;
    };

    // Two-column detection: academic PDFs put a second column starting past
    // the page midline. Building lines across the whole page braids the
    // columns ("same Y" pulls text from both) — detect and process each
    // column separately, left then right, with full-width lines (title,
    // abstract banner) kept ahead of the columns.
    const pageWidth = page.getViewport({ scale: 1 }).width;
    const mid = pageWidth / 2;
    const rightStarters = items.filter(it => it.x > mid + 5).length;
    const leftStarters = items.filter(it => it.x < mid - 5 && it.x + it.width < mid + 15).length;
    const twoColumn = items.length > 30 &&
      rightStarters > items.length * 0.25 &&
      leftStarters > items.length * 0.25;

    let lines: Line[];
    if (twoColumn) {
      const full: TextBlock[] = [];
      const left: TextBlock[] = [];
      const right: TextBlock[] = [];
      for (const it of items) {
        if (it.x < mid - 5 && it.x + it.width > mid + 30) full.push(it);      // spans the midline
        else if (it.x > mid + 5) right.push(it);
        else left.push(it);
      }
      lines = [...buildLines(full), ...buildLines(left), ...buildLines(right)];
    } else {
      lines = buildLines(items);
    }

    // Format lines to Markdown
    let pageMarkdown = '';
    let lastLine: Line | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let lineText = line.text;

      // Header Detection (short text + larger font size)
      let isHeader = false;
      if (lineText.length < 120) {
        if (line.fontSize >= medianFontSize * 1.5) {
          lineText = `# ${lineText}`;
          isHeader = true;
        } else if (line.fontSize >= medianFontSize * 1.25) {
          lineText = `## ${lineText}`;
          isHeader = true;
        } else if (line.fontSize >= medianFontSize * 1.12) {
          lineText = `### ${lineText}`;
          isHeader = true;
        }
      }

      const isList = /^(?:[•\-\*]|\d+\.)\s+/.test(lineText);

      if (i > 0 && lastLine) {
        const verticalGap = lastLine.y - line.y;
        const expectedSpacing = lastLine.fontSize * 1.6;

        if (isHeader || isList || verticalGap > expectedSpacing || verticalGap < 0) {
          pageMarkdown += '\n\n' + lineText;
        } else {
          // Paragraph continuation
          if (pageMarkdown.endsWith('-')) {
            // Strip hyphen and join
            pageMarkdown = pageMarkdown.slice(0, -1) + lineText;
          } else {
            pageMarkdown += ' ' + lineText;
          }
        }
      } else {
        pageMarkdown += lineText;
      }
      lastLine = line;
    }

    // PDF extraction splits citation brackets into separate positioned items
    // ("[ 87", "]"): re-join them so references read as [87] instead of
    // scattering bracket fragments through the text.
    pageMarkdown = pageMarkdown
      .replace(/\[\s+(\d)/g, '[$1')
      .replace(/(\d)\s+\]/g, '$1]')
      .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_m, g) => `[${g.replace(/\s+/g, '')}]`)
      .replace(/[ \t]{2,}/g, ' ');

    pages.push(pageMarkdown.trim());
  }
  return { pages, imagePages };
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
