// ─────────────────────────────────────────────
// PDF Parser — shared between service-worker and deep-researcher
// ─────────────────────────────────────────────
// Parses PDFs via pdf.js running in the offscreen document.
// Extracted here so both service-worker.ts (user captures) and
// deep-researcher.ts (research source ingestion) can share the logic
// without circular imports.

import { sendToOffscreen } from './offscreen-client';

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

/** Ensure the offscreen document exists (idempotent). */
export async function ensureOffscreen(): Promise<void> {
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
  ocrFn?: (dataUrl: string, instruction: string) => Promise<string>
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
    res = await sendToOffscreen({ action: 'OFFSCREEN_PARSE_PDF', base64 }, timeoutMs);
  } catch (e: any) {
    throw new Error(`PDF transfer failed (likely too large, ~${Math.round(base64.length / 1.33 / 1024 / 1024)} MB): ${e.message}`);
  }
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
  ocrFn?: (dataUrl: string, instruction: string) => Promise<string>
): Promise<string> {
  // Offscreen fetch is itself capped at 5 min (size-scaled) + parse time —
  // give the round-trip 8 min before declaring the offscreen doc wedged.
  const res: any = await sendToOffscreen({ action: 'OFFSCREEN_PARSE_PDF_URL', url }, 8 * 60 * 1000);
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
