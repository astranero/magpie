// ─────────────────────────────────────────────
// Inference worker — embeddings + re-ranking, OFF the offscreen main thread
// ─────────────────────────────────────────────
// transformers.js (ONNX) inference is CPU/GPU-heavy and, run inline, blocks the
// document's main thread. The offscreen document is co-located in the same
// renderer process as the sidepanel, so that block FREEZES the chat UI for the
// whole embed/rerank. Running it in a dedicated Worker keeps every page's main
// thread free — the UI stays responsive while this thread does the math.
//
// `chrome.*` APIs are NOT available in a Worker, so the WASM base URL is passed
// in via the `init` message (the offscreen doc computes chrome.runtime.getURL).

import { env, pipeline, AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

type Device = 'wasm' | 'webgpu';
type Req =
  | { type: 'init'; wasmPaths: string; device?: Device }
  | { type: 'set_device'; device: Device }
  | { id: number; type: 'embed'; texts: string[] }
  | { id: number; type: 'rerank'; query: string; passages: string[] };

// ── Embeddings ──

// Default WASM — see getEmbedder. The offscreen doc can override via the
// `inferenceDevice` setting (init / set_device).
let embedDevice: Device = 'wasm';
let embedder: any = null;
async function getEmbedder() {
  if (!embedder) {
    // Xenova mirror: onnx-community/all-MiniLM-L6-v2 went 401 (gated) on HF in
    // mid-2026. Same base model + ONNX export, embeddings stay compatible.
    //
    // Default WASM, not WebGPU: a heavy deep-research run embeds thousands of
    // chunks, and the WebGPU backend accumulates GPU buffers → the GPU/renderer
    // process OOMs and dies SILENTLY (no JS exception — the reported crash). WASM
    // keeps a bounded, GC'd heap on this worker thread; with the char + batch caps
    // below, allocation stays bounded. WebGPU is faster and available as an opt-in
    // (Settings → Inference acceleration); we fall back to WASM if it can't init.
    try {
      embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: embedDevice });
    } catch (e) {
      if (embedDevice !== 'wasm') {
        console.warn(`[worker] ${embedDevice} embedder init failed, falling back to wasm:`, e);
        embedDevice = 'wasm';
        embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: 'wasm' });
      } else throw e;
    }
  }
  return embedder;
}

// A std::bad_alloc from OrtRun leaves the WASM heap/session wedged — every
// subsequent call fails too. Tear the pipeline down so the next getEmbedder()
// rebuilds a fresh session on a clean heap instead of limping.
async function resetEmbedder(): Promise<void> {
  try { await embedder?.dispose?.(); } catch { /* best-effort */ }
  embedder = null;
}

// all-MiniLM context window is 256 tokens, but the tokenizer's model_max_length
// is the "no limit" sentinel, so the pipeline's internal truncation is a no-op.
// A long text then tokenizes to thousands of tokens, the whole batch pads to it,
// and OrtRun OOMs (std::bad_alloc). Cap chars so the sequence length — and thus
// peak allocation — is actually bounded. ~1000 chars stays under 256 tokens for
// English; the tail we drop is retrieval noise, not signal.
const MAX_EMBED_CHARS = 1000;
const capText = (t: string) => (t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t);

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  // 8 caps how many capped sequences are padded together per OrtRun; throughput
  // loss is negligible next to model inference time.
  const MAX_BATCH_SIZE = 8;

  const processBatch = async (rawBatch: string[]): Promise<number[][]> => {
    const batchTexts = rawBatch.map(capText);
    try {
      const extractor = await getEmbedder();
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
        if (start >= data.length || end > data.length) {
          throw new Error(`Index out of bounds: start=${start}, end=${end}, length=${data.length}`);
        }
        embeddings.push(Array.from(data.slice(start, end)));
      }
      return embeddings;
    } catch (batchErr) {
      // A batch OOM wedges the session — rebuild before the per-text retries,
      // otherwise they all fail on the same poisoned heap.
      console.warn('Batched embedding failed, resetting embedder and falling back to sequential:', batchErr);
      await resetEmbedder();

      // One text at a time bounds peak allocation to a single capped sequence.
      // We do NOT substitute a zero vector on failure: a zero embedding has
      // cosine 0 with every query, so it isn't just "missing" — it silently
      // corrupts retrieval and never surfaces. Throw instead; the caller then
      // stores the chunks vector-less (keyword-searchable) and can re-index.
      const embeddings: number[][] = [];
      for (const text of batchTexts) {
        try {
          const extractor = await getEmbedder();
          const output = await extractor(text, { pooling: 'mean', normalize: true });
          embeddings.push(Array.from(output.data as Float32Array));
        } catch {
          await resetEmbedder();
          try {
            const extractor = await getEmbedder();
            const output = await extractor(text, { pooling: 'mean', normalize: true });
            embeddings.push(Array.from(output.data as Float32Array));
          } catch (e2) {
            console.error('Failed to generate embedding after reset+retry:', e2);
            throw e2;
          }
        }
      }
      return embeddings;
    }
  };

  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    embeddings.push(...(await processBatch(batch)));
  }
  return embeddings;
}

// ── Re-ranking ──

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

// Bound peak allocation the same way the embedder does. Without this a single
// rerank of many long passages pads them ALL into one tensor, and if the
// tokenizer's model_max_length is the "no limit" sentinel, `truncation:true` is
// a no-op → the tensor explodes → OrtRun std::bad_alloc, which on a heavy deep-
// research run took down the whole offscreen renderer. ms-marco context is 512
// tokens; ~2000 chars stays under that for English.
const MAX_RERANK_CHARS = 2000;
const RERANK_MAX_LENGTH = 512;
const RERANK_BATCH = 16;

async function resetReranker(): Promise<void> {
  try { await rerankerModel?.dispose?.(); } catch { /* best-effort */ }
  tokenizer = null;
  rerankerModel = null;
}

async function rerank(query: string, passages: string[]): Promise<number[]> {
  const scores: number[] = [];
  for (let i = 0; i < passages.length; i += RERANK_BATCH) {
    const batch = passages.slice(i, i + RERANK_BATCH)
      .map(p => (p.length > MAX_RERANK_CHARS ? p.slice(0, MAX_RERANK_CHARS) : p));
    try {
      const { tokenizer, model } = await getReranker();
      const inputs = await tokenizer(Array(batch.length).fill(query), {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: RERANK_MAX_LENGTH,   // force truncation even if model_max_length is the sentinel
      });
      const { logits } = await model(inputs);
      const data = logits.data as Float32Array;
      for (let j = 0; j < batch.length; j++) scores.push(sigmoid(data[j]));
    } catch (err) {
      // A batch OOM wedges the session — rebuild before continuing so the rest
      // of the run doesn't fail on a poisoned heap. Neutral score for this batch.
      console.warn('Rerank batch failed, resetting reranker:', err);
      await resetReranker();
      for (let j = 0; j < batch.length; j++) scores.push(0.5);
    }
  }
  return scores;
}

// ── Message pump ──

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;

  if (req.type === 'init') {
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = req.wasmPaths;
    env.allowLocalModels = false;
    if (req.device === 'wasm' || req.device === 'webgpu') embedDevice = req.device;
    // Warm both models so the first real request doesn't pay init latency.
    Promise.all([
      getEmbedder().catch(err => console.warn('[worker preload] embedder failed:', err)),
      getReranker().catch(err => console.warn('[worker preload] reranker failed:', err)),
    ]).then(() => console.log(`[worker preload] models ready (embed device: ${embedDevice})`));
    return;
  }

  if (req.type === 'set_device') {
    if ((req.device === 'wasm' || req.device === 'webgpu') && req.device !== embedDevice) {
      embedDevice = req.device;
      await resetEmbedder();               // rebuild on the new device next call
      getEmbedder().catch(() => {});       // warm it
    }
    return;
  }

  try {
    if (req.type === 'embed') {
      const embeddings = await generateEmbeddings(req.texts);
      (self as any).postMessage({ id: req.id, ok: true, embeddings });
    } else if (req.type === 'rerank') {
      const scores = await rerank(req.query, req.passages);
      (self as any).postMessage({ id: req.id, ok: true, scores });
    }
  } catch (err) {
    (self as any).postMessage({ id: (req as any).id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
