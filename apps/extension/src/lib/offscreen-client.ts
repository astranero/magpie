// ─────────────────────────────────────────────
// Robust Offscreen Document Client
// ─────────────────────────────────────────────
// Handles automatic retry, recreation, and health checks
// for the offscreen document used by embeddings/parsing.

let offscreenFailureCount = 0;
const OFFSCREEN_MAX_FAILURES = 3;
let ensureOffscreenFn: (() => Promise<void>) | null = null;

/**
 * Set the ensureOffscreen function (called from service worker to avoid circular deps)
 */
export function setEnsureOffscreen(fn: () => Promise<void>) {
  ensureOffscreenFn = fn;
}

/** Default deadline for one offscreen round-trip. Generous — model download
 *  on first use plus a long embedding batch fit — but FINITE: an offscreen
 *  document that wedged (e.g. ONNX after an allocation failure) leaves the
 *  sendMessage promise pending forever, and everything serialized behind it
 *  (document saves, whole research runs) hangs un-abortably. */
const OFFSCREEN_DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Offscreen call timed out after ${Math.round(ms / 1000)}s: ${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// SERIALIZATION MUTEX — the offscreen doc runs ONE transformers.js/ONNX (WASM)
// context. Two embedding batches at once (e.g. a deep-research run + a chat
// query the user typed into the same chat mid-run) each allocate the model's
// working memory concurrently → the WASM heap OOMs → std::bad_alloc → the
// offscreen/renderer process crashes ("Chrome unexpectedly quit"). Chaining
// every call through this tail promise means at most one is in flight, so
// chat-during-research is safe — it just queues behind the run's current batch.
let queueTail: Promise<unknown> = Promise.resolve();

/**
 * Send message to offscreen document. Calls are SERIALIZED (see mutex above)
 * and each has automatic retry + a finite deadline; a dead offscreen doc is
 * recreated and the call retried once.
 */
export async function sendToOffscreen<T>(message: Record<string, unknown>, timeoutMs = OFFSCREEN_DEFAULT_TIMEOUT_MS): Promise<T> {
  const prev = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>(r => { release = r; });
  // Wait for the previous call to finish (success OR failure) before starting.
  await prev.catch(() => {});
  try {
    return await sendToOffscreenUnqueued<T>(message, timeoutMs);
  } finally {
    // Let the next queued call proceed — even if this one threw or timed out.
    release();
  }
}

async function sendToOffscreenUnqueued<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T> {
  if (!ensureOffscreenFn) {
    throw new Error('Offscreen ensure function not initialized');
  }

  await ensureOffscreenFn();

  const label = String(message.action || 'unknown');
  try {
    const res = await withTimeout(chrome.runtime.sendMessage(message) as Promise<T>, timeoutMs, label);
    offscreenFailureCount = 0;
    return res;
  } catch (err: any) {
    offscreenFailureCount++;
    console.warn(`[OffscreenClient] Send failed (${offscreenFailureCount}/${OFFSCREEN_MAX_FAILURES}):`, err?.message || err);
    
    // If too many failures, force recreation
    if (offscreenFailureCount >= OFFSCREEN_MAX_FAILURES) {
      console.warn('[OffscreenClient] Too many offscreen failures, forcing recreation');
      offscreenFailureCount = 0;
      await ensureOffscreenFn();
      // Retry once after recreation — still under a deadline
      return await withTimeout(chrome.runtime.sendMessage(message) as Promise<T>, timeoutMs, `${label} (retry)`);
    }
    throw err;
  }
}

/**
 * Health check for offscreen document
 */
export async function checkOffscreenHealth(): Promise<boolean> {
  try {
    await sendToOffscreen({ action: 'OFFSCREEN_HEALTH_CHECK' });
    return true;
  } catch {
    return false;
  }
}