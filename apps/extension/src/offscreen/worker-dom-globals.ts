// ─────────────────────────────────────────────
// Worker DOM globals — imported FIRST by parse.worker.ts
// ─────────────────────────────────────────────
// A module Worker has no `window` / `document` / `DOMParser`. Readability and
// Turndown are proven to work WITHOUT globals when handed a doc/node explicitly
// (verified in Node: both paths extract fine), but Vite may resolve their
// `browser` builds, which can reach for a global `document`/`window` on some code
// paths. So expose linkedom's DOM as globals defensively — importing this module
// before those libs means the globals exist by the time their code runs.
//
// CRITICAL: do NOT `Object.assign(globalThis, parseHTML(...))`. linkedom's bag
// includes `crypto`, and `globalThis.crypto` is a read-only getter in a Worker —
// the assign throws on that key and aborts the whole worker at load (which would
// break EVERY parse, worse than the fallback). Set each key individually, guarded.
import { parseHTML, DOMParser } from 'linkedom';

const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>') as any;
const g = globalThis as any;

// Only the DOM bits the libs might touch — never crypto/fetch/etc.
const KEYS = [
  'window', 'document', 'Node', 'Element', 'HTMLElement', 'Document',
  'DocumentFragment', 'Text', 'Comment', 'NodeFilter', 'XMLSerializer',
];
for (const k of KEYS) {
  try {
    if (dom[k] !== undefined && g[k] === undefined) g[k] = dom[k];
  } catch { /* read-only global — skip */ }
}
try { if (g.DOMParser === undefined) g.DOMParser = DOMParser; } catch { /* read-only */ }
// Turndown's `canUseDefaultDOMParser` reads `window`; point it at the worker global.
try { if (g.window === undefined) g.window = g; } catch { /* read-only */ }

export {};
