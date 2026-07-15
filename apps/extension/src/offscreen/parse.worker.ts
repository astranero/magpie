// ─────────────────────────────────────────────
// HTML → Markdown extractor — runs in a dedicated Worker isolate
// ─────────────────────────────────────────────
// Moved OFF the offscreen MAIN thread. DOMParser + Readability + Turndown build a
// full DOM per page (~40-90 MB); doing it inline on the main thread let that
// isolate's heap climb to its per-isolate V8 cap and OOM-crash the whole renderer
// (measured: heapMB 625→2569 across one stage). A Worker is a SEPARATE isolate with
// its OWN cap, so the parse heap here never touches the main thread — and the
// offscreen recycles this worker every N parses (terminate + respawn) to reset it,
// which is cheap (no model to reload, unlike the inference worker).
//
// linkedom provides a pure-JS DOM that works in a worker (there is no browser
// `document` here), so the exact Readability + Turndown logic that used to run on
// the main thread runs unchanged. Pure JS, no eval/wasm → fine under the offscreen
// CSP (`script-src 'self' 'wasm-unsafe-eval'`).

import { DOMParser, parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

// A Web Worker has NO `document` and NO `DOMParser`. Turndown falls back to
// `document.implementation.createHTMLDocument()` when it can't find a usable
// DOMParser, so without a global `document` it throws "document is not defined"
// (the captured worker error) and every parse fell back to cheap string extraction.
// Provide linkedom's DOM globals so Turndown + Readability run exactly as on a page.
const { document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
(globalThis as any).document = document;
(globalThis as any).DOMParser = DOMParser;

interface ParseReq { type: 'parse'; id: number; html: string; url: string }

function extract(html: string, url: string): { title: string; markdown: string; wordCount: number } {
  // linkedom's DOM types don't line up with lib.dom's; treat the doc as `any`.
  const parsed: any = new (DOMParser as any)().parseFromString(html, 'text/html');

  // Resolve relative URLs against the source page.
  const base = parsed.createElement('base');
  base.href = url;
  parsed.head?.prepend(base);

  const reader = new Readability(parsed, { keepClasses: true });
  const article = reader.parse();

  const htmlContent: string = article?.content || parsed.body?.innerHTML || '';
  const title: string = article?.title || parsed.title || 'Untitled';

  // Pass turndown a NODE, not a string. Turndown's STRING path calls an internal
  // HTML parser that needs a global DOMParser/document a Worker lacks (the captured
  // "document is not defined" error). Handing it an already-parsed linkedom node
  // skips that path entirely — turndown just clones and walks the node. Verified:
  // the node path works with no window/document globals present.
  const contentDoc: any = new (DOMParser as any)().parseFromString(`<div id="td-root">${htmlContent}</div>`, 'text/html');
  const contentNode = contentDoc.getElementById('td-root') || contentDoc.body;
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  let markdown = turndown.turndown(contentNode as any);
  markdown = markdown.replace(/\n{4,}/g, '\n\n\n').trim();

  const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;
  return { title, markdown, wordCount };
}

self.onmessage = (e: MessageEvent<ParseReq>) => {
  const req = e.data;
  if (req?.type !== 'parse') return;
  try {
    const { title, markdown, wordCount } = extract(req.html, req.url);
    (self as any).postMessage({ id: req.id, ok: true, title, markdown, wordCount });
  } catch (err) {
    (self as any).postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
