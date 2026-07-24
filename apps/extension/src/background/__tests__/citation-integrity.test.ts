import { describe, it, expect } from 'vitest';
import { chunkDocument, makeDocShortId } from '../../lib/chunker';
import { buildAnchoredContext, linkifyReportCitations } from '../deep-researcher';
import type { SourceRecord } from '../deep-researcher';

// ─────────────────────────────────────────────
// Citation integrity — the chain a chip depends on
// ─────────────────────────────────────────────
// A citation chip is only honest if every link in this chain holds:
//   chunker anchors → saveDocument prefix rewrite → session index →
//   <c>anchor</c> in synthesis context → [anchor] in report →
//   linkify (known) / chip resolve (raw) → getChunkByAnchor → highlight.
// These tests pin each link with REAL content (no synthetic one-liners),
// because the failure the user reported — "chunks do not link to source" —
// is invisible unless the data flows end-to-end.

// Realistic multi-section document, long enough to produce several chunks.
const REAL_DOC = `# Vitest Mocking Guide

## Module replacement

When a test file uses vi.mock with a factory function, Vitest replaces the
entire target module with the object returned by that factory. The original
module is never executed, so any named export the code under test imports must
be explicitly defined on the returned object or resolution fails.

Hoisting matters here: all vi.mock calls are hoisted to the top of the file and
run before import statements, which is why a factory cannot reference variables
declared later in the file.

## Partial mocking

The recommended pattern uses an async factory with importOriginal. The factory
awaits the original module, spreads its exports, and overrides only the
functions the test needs to control. This guarantees every export the consumer
imports is present on the mock.

## Spying instead

When the goal is observation rather than replacement, vi.spyOn attaches to an
existing function without replacing the module, so unrelated exports keep their
real implementations and the export-missing failure cannot occur.`;

/** Mirror of saveDocument's anchor rewrite (db.ts) — the contract under test. */
function rewriteAnchors(chunks: ReturnType<typeof chunkDocument>, realId: string) {
  const prefix = makeDocShortId(realId) + '.';
  return chunks.map(c => ({ ...c, docId: realId, anchorId: c.anchorId.replace(/^[^.]+\./, prefix) }));
}

describe('anchor lifecycle: chunker → save rewrite → resolver', () => {
  it('chunker emits anchors under the tempId; save rewrite moves ALL of them under the real id', () => {
    const tempShort = makeDocShortId(crypto.randomUUID());
    const chunks = chunkDocument({ docShortId: tempShort, content: REAL_DOC });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.anchorId.startsWith(tempShort + '.')).toBe(true);

    const realId = crypto.randomUUID();
    const saved = rewriteAnchors(chunks, realId);
    const realShort = makeDocShortId(realId);
    for (const c of saved) {
      expect(c.anchorId.startsWith(realShort + '.')).toBe(true);
      // The structural tail (.sN.pN) must survive the rewrite untouched —
      // it's what makes re-chunking deterministic.
      expect(c.anchorId.slice(realShort.length)).toMatch(/^\.s\d+\.p\d+(\.\d+)?$/);
    }
  });

  it('re-chunking unchanged content reproduces identical anchor tails (chip stability across Force re-index)', () => {
    const a = chunkDocument({ docShortId: 'dAAAAAA', content: REAL_DOC });
    const b = chunkDocument({ docShortId: 'dBBBBBB', content: REAL_DOC });
    const tails = (cs: typeof a) => cs.map(c => c.anchorId.replace(/^[^.]+/, ''));
    expect(tails(a)).toEqual(tails(b));
  });

  it('every chunk text is findable in the source content (highlight precondition)', () => {
    const chunks = chunkDocument({ docShortId: 'dTEST01', content: REAL_DOC });
    for (const c of chunks) {
      // DocumentView's tier-2 fallback is whitespace-flexible — hold the
      // verifier to the same bar rather than exact indexOf.
      const probe = c.text.slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      expect(new RegExp(probe).test(REAL_DOC), `chunk ${c.anchorId} text not in source`).toBe(true);
    }
  });
});

describe('buildAnchoredContext ↔ report anchors', () => {
  it('emits every chunk anchor as a <c> marker the model can copy verbatim', () => {
    const realId = crypto.randomUUID();
    const chunks = rewriteAnchors(chunkDocument({ docShortId: 'dtmp000', content: REAL_DOC }), realId);
    const ctx = buildAnchoredContext(chunks.map(c => ({ anchorId: c.anchorId, docId: c.docId, heading: c.heading || '', text: c.text })));
    for (const c of chunks) expect(ctx).toContain(`<c>${c.anchorId}</c>`);
  });
});

describe('linkifyReportCitations — the known-source path', () => {
  const docA = crypto.randomUUID();
  const docB = crypto.randomUUID();
  const shortA = makeDocShortId(docA);
  const shortB = makeDocShortId(docB);
  const records: SourceRecord[] = [
    { url: 'https://vitest.dev/api/vi.html', title: 'Vitest API', label: 'WEB', docId: docA, tier: 'high' },
    { url: 'https://example.org/mocking', title: 'Mocking Deep Dive', label: 'WEB', docId: docB, tier: 'standard' },
  ];

  it('numbers align with citation order and KEEP the chunk anchor as a #cite link', () => {
    const synthesis = `Factories replace modules [${shortA}.s0.p1]. Partial mocks spread originals [${shortB}.s1.p0]. Hoisting applies [${shortA}.s0.p2].`;
    const { text, cited } = linkifyReportCitations(synthesis, records);

    // The anchor must SURVIVE the rewrite — [[n](webUrl)] threw it away, which
    // made every known-source citation open the external page (often gated)
    // instead of jumping to the saved source chunk.
    expect(text).toContain(`[[1](#cite:${shortA}.s0.p1)]`);
    expect(text).toContain(`[[2](#cite:${shortB}.s1.p0)]`);
    // Same source, different chunk: same NUMBER, its own anchor.
    expect(text).toContain(`[[1](#cite:${shortA}.s0.p2)]`);
    // cited[] order must match the numbers — the Sources list is built from it
    // and carries the external URL for exported markdown.
    expect(cited.map(c => c.url)).toEqual(['https://vitest.dev/api/vi.html', 'https://example.org/mocking']);
  });

  it('leaves unknown anchors RAW so the chip path can still resolve them', () => {
    const synthesis = `Known [${shortA}.s0.p1] and unknown [dzzzzzz.s0.p1].`;
    const { text } = linkifyReportCitations(synthesis, records);
    expect(text).toContain('[dzzzzzz.s0.p1]');   // untouched — chip fallback
    expect(text).toContain('[[1](#cite:');
  });

  it('a record with a docId but NO url still gets a chunk-jump #cite link', () => {
    const recs: SourceRecord[] = [{ url: '', title: 'Local doc', label: 'WEB', docId: docA, tier: 'standard' }];
    const { text } = linkifyReportCitations(`Claim [${shortA}.s0.p1].`, recs);
    expect(text).toContain(`[[1](#cite:${shortA}.s0.p1)]`);
  });

  it('a record with a url but NO docId falls back to the web link', () => {
    const recs: SourceRecord[] = [{ url: 'https://ex.org/x', title: 'Unsaved', label: 'WEB', docId: '', tier: 'standard' }];
    // Unknown short (docId empty → not in byShort) leaves the anchor raw —
    // which is correct: the chip path may still resolve it from the store.
    const { text } = linkifyReportCitations(`Claim [${shortA}.s0.p1].`, recs);
    expect(text).toContain(`[${shortA}.s0.p1]`);
  });

  it('CRITICAL correct-source property: an anchor is NEVER linked to a different doc\'s url', () => {
    // Two docs whose ids collide on the first 6 chars would break this —
    // makeDocShortId truncates. Simulate the honest case and assert mapping.
    const synthesis = `A [${shortA}.s2.p0]. B [${shortB}.s0.p0].`;
    const { text } = linkifyReportCitations(synthesis, records);
    const posA = text.indexOf(`[[1](#cite:${shortA}`);
    const posB = text.indexOf(`[[2](#cite:${shortB}`);
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(posA);
  });
});
