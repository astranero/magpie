// ─────────────────────────────────────────────
// PDF Parser — shared between service-worker and deep-researcher
// ─────────────────────────────────────────────
// Parses PDFs via pdf.js running in the offscreen document.
// Extracted here so both service-worker.ts (user captures) and
// deep-researcher.ts (research source ingestion) can share the logic
// without circular imports.

import { sendToOffscreen } from './offscreen-client';
import { crumb } from './crash-log';

/** Convert an ArrayBuffer to a base64 string without stack overflow on large files. */
import { looksLikeOcrGarbage } from './quality-gate';

export function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Module-level promise so concurrent callers wait for a single creation attempt.
let offscreenReady: Promise<void> | null = null;

/**
 * Tear down the offscreen document to reclaim its renderer memory, then let the
 * next ensureOffscreen() recreate it fresh. The offscreen is a STATELESS
 * parser/embedder proxy — every durable thing (source chunks in IndexedDB, stage
 * briefs/handoff in the worker) lives elsewhere — so this is safe to call between
 * research stages. Over one stage of continuous embedding + PDF/HTML parsing the
 * renderer heap climbs to ~2.7 GB; recreating it drops that back to a few MB.
 */
export async function recreateOffscreen(): Promise<void> {
  const off = chrome.offscreen as any;
  // Block reuse first: any concurrent ensureOffscreen() must re-decide, not race us.
  offscreenReady = null;
  try {
    const had = await off.hasDocument?.();
    if (had) {
      await off.closeDocument?.();
      // closeDocument() RESOLVES BEFORE the renderer is actually torn down. Poll
      // until hasDocument() flips false so we don't reuse a dying doc.
      let stillThere = true;
      for (let i = 0; i < 30 && stillThere; i++) {
        stillThere = !!(await off.hasDocument?.());
        if (stillThere) await new Promise(r => setTimeout(r, 100));
      }
      // …but even after the doc reports closed, Chrome POOLS the renderer process
      // and reuses it if we createDocument() immediately — so usedJSHeapSize
      // carries the previous stage's ~2 GB across the "reclaim" (measured: heap
      // ratcheted 920→1359→1267→2658 MB across reclaimed stage boundaries, never
      // resetting mid-SW-life). A settle delay lets Chrome actually reap the
      // renderer process, so the next createDocument() spawns a FRESH low-heap one.
      await new Promise(r => setTimeout(r, 1500));
      crumb('offscreen', 'recreate: closed', { stillThere });
    }
  } catch (e: any) {
    crumb('offscreen', 'recreate: error', { err: String(e?.message || e) });
  }
  offscreenReady = null;
}

/**
 * Recycle the offscreen's inference worker — terminate() + respawn — to reclaim
 * its ONNX/WASM heap, which only grows (never shrinks) with each embedded source.
 * Unlike recreateOffscreen(), this works RELIABLY mid-run: closeDocument() won't
 * fire while the offscreen has active message traffic, but the worker can always
 * be torn down between calls. Routed through the offscreen mutex so it waits for
 * any in-flight embed to finish first.
 */
export async function recycleOffscreenWorker(): Promise<void> {
  await ensureOffscreen();
  await sendToOffscreen({ action: 'OFFSCREEN_RECYCLE_WORKER' }, 30_000).catch(() => { /* best-effort */ });
}

/** Ensure the offscreen document exists (idempotent). */
export async function ensureOffscreen(): Promise<void> {
  // The offscreen can vanish out from under us — its own idle watchdog calls
  // window.close() to free the renderer between runs. If our cached (resolved)
  // promise points at a doc that's gone, drop it so we rebuild instead of routing
  // messages into a closed document. hasDocument() is a cheap SW-local API call.
  try {
    if (offscreenReady && !(await (chrome.offscreen as any).hasDocument?.())) offscreenReady = null;
  } catch { /* hasDocument unavailable — fall through to the create path */ }
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const has = await (chrome.offscreen as any).hasDocument?.();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
          justification: 'Parse PDFs and HTML into text for the knowledge base'
        });
      }
    })().catch(err => { offscreenReady = null; throw err; });
  }
  return offscreenReady;
}

/**
 * Parse a base64-encoded PDF into a markdown body via pdf.js in the offscreen doc.
 *
 * @param base64 - Base64-encoded PDF bytes.
 * @param ocrFn  - Optional async function that converts a scanned-page image (data URL)
 *                 to text. When omitted, scanned pages are emitted as
 *                 "*(no extractable text)*" without calling a vision model.
 *                 Pass `undefined` for research runs to keep timing predictable.
 */
export async function pdfBase64ToBody(
  base64: string,
  ocrFn?: (dataUrl: string, instruction: string) => Promise<string>,
  silent = false
): Promise<string> {
  // Guard against the sendMessage payload cap (~64 MB). base64 is ~1.33× the
  // byte size; anything near the cap must go through the URL path instead.
  if (base64.length > 48 * 1024 * 1024) {
    throw new Error(`PDF too large to transfer as base64 (${Math.round(base64.length / 1.33 / 1024 / 1024)} MB). Use the URL parse path.`);
  }
  let res: any;
  try {
    // A big, page-heavy PDF (a 400+ page book) can genuinely take many minutes
    // to parse in the offscreen doc. Scale the deadline with the payload size
    // (~1 min per MB, 8–25 min) so a slow-but-progressing parse finishes instead
    // of being cut off and failing silently. Still finite — a wedged offscreen
    // doc must not hang the import forever.
    const approxMb = base64.length / 1.33 / 1024 / 1024;
    const timeoutMs = Math.min(25 * 60 * 1000, Math.max(8 * 60 * 1000, Math.round(approxMb) * 60 * 1000));
    res = await sendToOffscreen({ action: 'OFFSCREEN_PARSE_PDF', base64, silent }, timeoutMs);
  } catch (e: any) {
    throw new Error(`PDF transfer failed (likely too large, ~${Math.round(base64.length / 1.33 / 1024 / 1024)} MB): ${e.message}`);
  }
  if (!res?.ok) throw new Error(res?.error || 'PDF parse failed');
  return assemblePdfBody(res, ocrFn);
}

/**
 * Parse a PDF the sidepanel streamed into OPFS. The bytes never cross a message
 * boundary (no base64, no 14 MB string copies), so this is the safe path for
 * LOCAL PDFs of any size — the base64 read is what OOM-crashed the renderer.
 * Deadline scales with the file size (~1 min/MB, 8–25 min).
 */
export async function pdfOpfsToBody(
  opfsName: string,
  sizeBytes: number,
  ocrFn?: (dataUrl: string, instruction: string) => Promise<string>,
  silent = false
): Promise<string> {
  const approxMb = sizeBytes / 1024 / 1024;
  const timeoutMs = Math.min(25 * 60 * 1000, Math.max(8 * 60 * 1000, Math.round(approxMb) * 60 * 1000));
  const res: any = await sendToOffscreen({ action: 'OFFSCREEN_PARSE_PDF_OPFS', opfsName, silent }, timeoutMs);
  if (!res?.ok) throw new Error(res?.error || 'PDF parse failed');
  return assemblePdfBody(res, ocrFn);
}

/**
 * Parse a PDF by URL — the offscreen document fetches and parses it itself,
 * so multi-MB PDFs never cross the message boundary. Preferred for any
 * URL-sourced PDF (captures, arXiv full-text, page context).
 */
export async function pdfUrlToBody(
  url: string,
  ocrFn?: (dataUrl: string, instruction: string) => Promise<string>,
  silent = false
): Promise<string> {
  // Offscreen fetch is itself capped at 5 min (size-scaled) + parse time —
  // give the round-trip 8 min before declaring the offscreen doc wedged.
  const res: any = await sendToOffscreen({ action: 'OFFSCREEN_PARSE_PDF_URL', url, silent }, 8 * 60 * 1000);
  if (!res?.ok) throw new Error(res?.error || 'PDF parse failed');
  return assemblePdfBody(res, ocrFn);
}

async function assemblePdfBody(
  res: { pages?: string[]; imagePages?: Array<{ index: number; dataUrl: string }> },
  ocrFn?: (dataUrl: string, instruction: string) => Promise<string>
): Promise<string> {
  const pages: string[] = res.pages || [];
  const imagePages: Array<{ index: number; dataUrl: string }> = res.imagePages || [];

  const ocrByIndex = new Map<number, string>();
  if (ocrFn) {
    for (const img of imagePages) {
      try {
        const text = await ocrFn(
          img.dataUrl,
          'Transcribe all text from this scanned PDF page exactly, preserving structure. Output markdown only.'
        );
        if (text.trim()) ocrByIndex.set(img.index, text.trim());
      } catch (e) {
        console.warn('OCR failed for page', img.index, e);
      }
    }
  }

  return pages.map((t, i) => {
    const pageNo = i + 1;
    const codeText = t.trim();
    const ocr = ocrByIndex.get(pageNo);
    let chosen = codeText.length >= 20 ? codeText : (ocr || codeText);
    // OCR/extraction garbage (symbol soup, broken encodings) pollutes the
    // index — drop the page body rather than indexing noise.
    if (chosen && looksLikeOcrGarbage(chosen)) {
      console.warn(`PDF page ${pageNo}: extracted text looks like OCR garbage, skipping`);
      chosen = '';
    }
    return `## Page ${pageNo}\n\n${chosen || '*(no extractable text)*'}`;
  }).join('\n\n');
}
