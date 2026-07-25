// ─────────────────────────────────────────────
// MAIN-world network observer (endpoint discovery)
// ─────────────────────────────────────────────
// Runs in the PAGE's world at document_start so it wraps window.fetch and
// XMLHttpRequest BEFORE the page issues its own API calls. It records ONLY the
// {method, url} of each request into a capped, deduped page global
// (window.__magpieNet). It never reads request/response bodies or headers, so
// no tokens or payloads are captured — the service worker reads this buffer
// (GET_PAGE_API_CALLS) and redacts token-like query values before the model
// ever sees an endpoint.
//
// Built as its own self-contained bundle (no imports); declared MAIN-world +
// document_start in the manifest.

(() => {
  const KEY = '__magpieNet';
  const w = window as any;
  if (w[KEY]) return; // already installed on this page

  const buf: Array<{ method: string; url: string; t: number }> = [];
  w[KEY] = buf;
  const MAX = 120;
  const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|ico|mp4|webm|mp3|wasm)(\?|#|$)/i;

  const record = (methodRaw: string, urlRaw: string) => {
    try {
      if (!urlRaw) return;
      const abs = new URL(urlRaw, location.href).href;
      if (!/^https?:/.test(abs)) return;
      if (ASSET.test(abs)) return;
      const method = (methodRaw || 'GET').toUpperCase();
      // Dedup by method + path (ignore query) so a paginated endpoint logs once;
      // keep the newest full URL (with its query) as the example.
      const pathKey = method + ' ' + abs.split('?')[0];
      const i = buf.findIndex(e => (e.method + ' ' + e.url.split('?')[0]) === pathKey);
      if (i !== -1) { buf[i] = { method, url: abs, t: Date.now() }; return; }
      buf.push({ method, url: abs, t: Date.now() });
      if (buf.length > MAX) buf.shift();
    } catch { /* never break the page */ }
  };

  // fetch
  const origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    w.fetch = function (this: any, input: any, init?: any) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url);
        const method = (init && init.method) || (input && input.method) || 'GET';
        record(method, url);
      } catch { /* ignore */ }
      return origFetch.apply(this, arguments as any);
    };
  }

  // XMLHttpRequest
  const XHR = w.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (this: any, method: string, url: string) {
      try { record(method, url); } catch { /* ignore */ }
      return origOpen.apply(this, arguments as any);
    };
  }
})();
