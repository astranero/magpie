// ─────────────────────────────────────────────
// Crash-surviving breadcrumb log
// ─────────────────────────────────────────────
// A renderer/worker OOM kills the process and takes the console with it — so an
// error logged AT the crash is lost. Instead we persist small breadcrumbs to
// chrome.storage.local BEFORE each risky operation. When the process dies, the
// LAST breadcrumb that committed tells us what it was doing (e.g. "parsing PDF
// 48MB"). On the next startup we dump them to the console.
//
// Available wherever chrome.storage is (service worker, offscreen doc, sidepanel)
// — NOT inside a Worker (no chrome.*). The offscreen doc crumbs on the Worker's
// behalf.

const KEY = 'crashLog';
const MAX = 300;

export interface Crumb { t: number; s: string; m: string; d?: string }

let buf: Crumb[] | null = null; // in-memory mirror, lazily hydrated

// chrome.storage is NOT available in every extension context — an offscreen
// document only exposes chrome.runtime, so touching chrome.storage.local there
// throws "Cannot read properties of undefined (reading 'local')" and, if it's at
// module top-level, kills the whole document. Feature-detect instead of assuming.
function localStore(): chrome.storage.StorageArea | null {
  try { return (chrome as any)?.storage?.local ?? null; } catch { return null; }
}

async function load(): Promise<Crumb[]> {
  if (buf) return buf;
  const store = localStore();
  if (!store) { buf = []; return buf; }
  try {
    const r = await store.get(KEY);
    buf = Array.isArray(r[KEY]) ? r[KEY] : [];
  } catch { buf = []; }
  return buf!;
}

/** Append + persist a crumb in a context that HAS chrome.storage. */
function append(c: Crumb): void {
  void (async () => {
    const b = await load();
    b.push(c);
    if (b.length > MAX) b.splice(0, b.length - MAX);
    try { await localStore()?.set({ [KEY]: b }); } catch { /* best-effort */ }
  })();
}

/**
 * Record a breadcrumb. Persisted immediately (not debounced) so it survives a
 * crash in the very next operation — keep call sites COARSE (per PDF, per embed
 * batch, per research stage), not per-item, to bound storage churn.
 *
 * In a context without chrome.storage (the offscreen document — which is exactly
 * where the PDF/embed/rerank crashes happen), the crumb is handed to the service
 * worker over runtime messaging so it still gets persisted. See
 * `installCrumbReceiver` on the SW side.
 */
export function crumb(scope: string, msg: string, data?: unknown): void {
  const c: Crumb = { t: Date.now(), s: scope, m: msg };
  if (data !== undefined) {
    try { c.d = typeof data === 'string' ? data : JSON.stringify(data); }
    catch { c.d = String(data); }
    if (c.d.length > 500) c.d = c.d.slice(0, 500);
  }
  if (localStore()) { append(c); return; }
  try { (chrome as any)?.runtime?.sendMessage?.({ action: 'CRASH_CRUMB', crumb: c }); }
  catch { /* nothing else we can do from here */ }
}

/** Register a receiver so crumbs forwarded from a storage-less context (the
 *  offscreen doc) get persisted here. Call ONCE from a context WITH chrome
 *  .storage (the service worker). No-op if messaging isn't available. */
export function installCrumbReceiver(): void {
  try {
    (chrome as any)?.runtime?.onMessage?.addListener?.((req: any) => {
      if (req?.action === 'CRASH_CRUMB' && req.crumb) append(req.crumb as Crumb);
      // Don't return true — this is fire-and-forget, no response.
    });
  } catch { /* ignore */ }
}

export async function getCrashLog(): Promise<Crumb[]> {
  return load();
}

export async function clearCrashLog(): Promise<void> {
  buf = [];
  try { await localStore()?.set({ [KEY]: [] }); } catch { /* ignore */ }
}

/** Human-readable dump (also the format the Settings "copy" button produces). */
export function formatCrashLog(crumbs: Crumb[]): string {
  return crumbs.map(c => {
    const ts = new Date(c.t).toISOString().slice(11, 23);
    return `${ts} [${c.s}] ${c.m}${c.d ? ' — ' + c.d : ''}`;
  }).join('\n');
}

/** Print the persisted breadcrumbs to the console — call on startup so a reload
 *  after a crash surfaces what came just before it. */
export async function dumpCrashLog(label = '[crashlog]'): Promise<void> {
  const b = await load();
  if (!b.length) return;
  console.log(`${label} ${b.length} breadcrumb(s) persisted before this start (most recent last):\n${formatCrashLog(b.slice(-60))}`);
}

/** Route uncaught errors + unhandled rejections into breadcrumbs. */
export function installCrashHandlers(scope: string): void {
  try {
    (self as any).addEventListener?.('error', (e: any) => {
      crumb(scope, 'uncaught error', e?.message || String(e?.error || e));
    });
    (self as any).addEventListener?.('unhandledrejection', (e: any) => {
      crumb(scope, 'unhandled rejection', e?.reason?.message || String(e?.reason));
    });
  } catch { /* ignore */ }
}
