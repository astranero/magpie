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

/**
 * Send message to offscreen document with automatic retry on failure.
 * If offscreen doc is dead, recreates it and retries once. Every call has a
 * finite deadline; a timeout counts as a failure toward forced recreation.
 */
export async function sendToOffscreen<T>(message: Record<string, unknown>, timeoutMs = OFFSCREEN_DEFAULT_TIMEOUT_MS): Promise<T> {
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