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

/**
 * Send message to offscreen document with automatic retry on failure.
 * If offscreen doc is dead, recreates it and retries once.
 */
export async function sendToOffscreen<T>(message: Record<string, unknown>): Promise<T> {
  if (!ensureOffscreenFn) {
    throw new Error('Offscreen ensure function not initialized');
  }
  
  await ensureOffscreenFn();
  
  try {
    const res = await chrome.runtime.sendMessage(message) as T;
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
      // Retry once after recreation
      return await chrome.runtime.sendMessage(message) as T;
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