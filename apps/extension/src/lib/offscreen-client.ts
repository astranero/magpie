// ─────────────────────────────────────────────
// Robust Offscreen Document Client
// ─────────────────────────────────────────────
// Handles automatic retry, recreation, and health checks
// for the offscreen document used by embeddings/parsing.

let offscreenFailureCount = 0;
const OFFSCREEN_MAX_FAILURES = 3;
let ensureOffscreenFn: (() => Promise<void>) | null = null;
let recreateOffscreenFn: (() => Promise<void>) | null = null;

/**
 * Set the ensureOffscreen function (called from service worker to avoid circular deps)
 */
export function setEnsureOffscreen(fn: () => Promise<void>) {
  ensureOffscreenFn = fn;
}

/**
 * Set the recreateOffscreen function (close + fresh create). Used after repeated
 * failures: re-ENSURING a wedged document no-ops (it exists), so the retry would
 * go to the same broken doc and time out again.
 */
export function setRecreateOffscreen(fn: () => Promise<void>) {
  recreateOffscreenFn = fn;
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
// offscreen/renderer process crashes ("Chrome unexpectedly quit"). At most one
// call is ever in flight, so chat-during-research can never OOM.
//
// PRIORITY — a plain FIFO made chat "freeze" during a deep-research run: the
// run enqueues dozens of embedding batches, and a chat query the user typed
// then waited behind ALL of them (minutes). So the queue is priority-ordered:
// an interactive chat call jumps ahead of not-yet-started research batches and
// waits at most for the ONE batch currently in flight (seconds). Ordering is
// stable within a priority tier (FIFO), so research still makes progress.
type Waiter = { priority: boolean; wake: () => void };
let running = false;
const waiters: Waiter[] = [];

function acquire(priority: boolean): Promise<void> {
  if (!running) { running = true; return Promise.resolve(); }
  return new Promise<void>(wake => {
    if (priority) {
      // Sit after any already-waiting priority calls, ahead of all normals.
      let i = 0;
      while (i < waiters.length && waiters[i].priority) i++;
      waiters.splice(i, 0, { priority, wake });
    } else {
      waiters.push({ priority, wake });
    }
  });
}

function releaseNext(): void {
  const next = waiters.shift();
  if (next) next.wake();
  else running = false;
}

/**
 * Send message to offscreen document. Calls are SERIALIZED (see mutex above)
 * and each has automatic retry + a finite deadline; a dead offscreen doc is
 * recreated and the call retried once. Pass `priority` for latency-sensitive
 * interactive calls (a chat turn) so they don't starve behind a research run.
 */
export async function sendToOffscreen<T>(message: Record<string, unknown>, timeoutMs = OFFSCREEN_DEFAULT_TIMEOUT_MS, opts?: { priority?: boolean }): Promise<T> {
  await acquire(!!opts?.priority);
  try {
    return await sendToOffscreenUnqueued<T>(message, timeoutMs);
  } finally {
    // Hand the lock to the next waiter — even if this one threw or timed out.
    releaseNext();
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
    
    // If too many failures, force recreation — actually CLOSE the wedged doc
    // (ensureOffscreen no-ops while it exists, which is why the old code retried
    // the same broken document and timed out again).
    if (offscreenFailureCount >= OFFSCREEN_MAX_FAILURES) {
      console.warn('[OffscreenClient] Too many offscreen failures, forcing recreation');
      offscreenFailureCount = 0;
      if (recreateOffscreenFn) await recreateOffscreenFn().catch(() => {});
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