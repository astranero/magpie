import { describe, it, expect } from 'vitest';
import { assembleReportBody, linkifyReportCitations } from '../deep-researcher';
import type { SourceRecord } from '../deep-researcher';
import { makeDocShortId } from '../../lib/chunker';

// ─────────────────────────────────────────────
// Number ↔ source alignment — the report's trust core
// ─────────────────────────────────────────────
// A numbered citation that names the WRONG source is worse than none: the
// reader verifies against the wrong document and walks away confident. These
// tests hold assembleReportBody to its invariant on every shape a real run
// produces — repeats, mixed cited/uncited, missing urls, unknown anchors,
// and short-id collisions.

const uuid = () => crypto.randomUUID();

function rec(docId: string, url: string, title: string): SourceRecord {
  return { docId, url, title, label: 'WEB', tier: 'standard' };
}

/**
 * THE verifier. Parses every [[n](#cite:anchor)] out of an assembled body and
 * checks each against the Sources list:
 *   1. ordered[n-1] exists and its docId's short id == the anchor's prefix
 *   2. the "n." line in the rendered ## Sources section carries that record's
 *      title or url (what the reader actually sees)
 * Returns the count checked so tests can assert coverage isn't vacuous.
 */
function verifyAlignment(body: string, ordered: SourceRecord[]): number {
  const sourcesAt = body.indexOf('\n## Sources\n');
  expect(sourcesAt, 'no Sources section').toBeGreaterThan(-1);
  const sourceLines = body.slice(sourcesAt).split('\n').filter(l => /^\d+\. /.test(l));

  const re = /\[\[(\d+)\]\(#cite:(([a-z]\w{1,8})\.s\d+\.p\d+(?:\.\d+)?)\)\]/gi;
  let m: RegExpExecArray | null;
  let checked = 0;
  while ((m = re.exec(body.slice(0, sourcesAt))) !== null) {
    const n = parseInt(m[1], 10);
    const short = m[3];
    const recAtN = ordered[n - 1];
    expect(recAtN, `citation [[${n}]] has no Sources entry ${n}`).toBeTruthy();
    expect(makeDocShortId(recAtN.docId), `[[${n}](#cite:${m[2]})] numbered as "${recAtN.title}" but anchor belongs to a different doc`).toBe(short);

    const line = sourceLines[n - 1] || '';
    const visible = recAtN.title || recAtN.url;
    expect(line.includes(recAtN.url) || line.includes(recAtN.title), `Sources line ${n} ("${line}") does not show ${visible}`).toBe(true);
    checked++;
  }
  return checked;
}

describe('assembleReportBody: [[n]] ↔ Sources alignment', () => {
  it('holds on a realistic multi-source report with repeats and an uncited source', () => {
    const [dA, dB, dC, dD] = [uuid(), uuid(), uuid(), uuid()];
    const [sA, sB, sC] = [dA, dB, dC].map(makeDocShortId);
    const sources = [
      rec(dA, 'https://vitest.dev/api', 'Vitest API'),
      rec(dB, 'https://nginx.org/docs', 'Nginx Docs'),
      rec(dC, 'https://react.dev/learn', 'React Learn'),
      rec(dD, 'https://example.org/never-cited', 'Uncited Extra'),
    ];
    // B cited FIRST — citation order, not sources-array order, drives numbering.
    const synthesis =
      `Buffering bursts streams [${sB}.s0.p1]. Factories replace modules [${sA}.s1.p0], ` +
      `and hoisting applies [${sA}.s1.p2]. Memoization freezes turns [${sC}.s3.p0]. ` +
      `Again on buffering [${sB}.s2.p0].`;

    const { body, ordered } = assembleReportBody(synthesis, 'test topic', sources);
    const checked = verifyAlignment(body, ordered);
    expect(checked).toBe(5);

    // Citation order: B=1, A=2, C=3; uncited D trails as 4.
    expect(ordered.map(r => r.title)).toEqual(['Nginx Docs', 'Vitest API', 'React Learn', 'Uncited Extra']);
    expect(body).toContain(`[[1](#cite:${sB}.s0.p1)]`);
    expect(body).toContain(`[[2](#cite:${sA}.s1.p0)]`);
    expect(body).toContain(`[[2](#cite:${sA}.s1.p2)]`);
    expect(body).toContain(`[[3](#cite:${sC}.s3.p0)]`);
    expect(body).toContain('4. [Uncited Extra](https://example.org/never-cited)');
  });

  it('holds across 40 randomized reports (fuzz: order, repeats, uncited, url-less)', () => {
    for (let trial = 0; trial < 40; trial++) {
      const docs = Array.from({ length: 2 + (trial % 5) }, (_, i) => ({
        id: uuid(),
        rec: rec('', `https://ex${trial}.org/${i}`, `Doc ${trial}-${i}`),
      }));
      docs.forEach(d => { d.rec.docId = d.id; });
      // Some records lose their url (saved doc is the only home).
      if (trial % 3 === 0) docs[0].rec.url = '';

      // Random citation sequence over a random subset.
      const citedDocs = docs.slice(0, 1 + (trial % docs.length));
      const seq = Array.from({ length: 1 + (trial * 7) % 9 }, (_, k) =>
        citedDocs[(trial + k * 3) % citedDocs.length]);
      const synthesis = seq
        .map((d, k) => `Claim ${k} [${makeDocShortId(d.id)}.s${k % 4}.p${(k * 2) % 5}].`)
        .join(' ');

      const { body, ordered } = assembleReportBody(synthesis, `topic ${trial}`, docs.map(d => d.rec));
      const checked = verifyAlignment(body, ordered);
      expect(checked, `trial ${trial} verified nothing`).toBe(seq.length);
      // Every source appears exactly once in the Sources list.
      const lines = body.slice(body.indexOf('## Sources')).split('\n').filter(l => /^\d+\. /.test(l));
      expect(lines.length).toBe(ordered.length);
    }
  });

  it('unknown anchors stay raw and never consume a Sources number', () => {
    const dA = uuid();
    const sources = [rec(dA, 'https://ex.org/a', 'A')];
    const synthesis = `Known [${makeDocShortId(dA)}.s0.p0]. Ghost [dzzzzzz.s0.p0].`;
    const { body, ordered } = assembleReportBody(synthesis, 't', sources);
    expect(body).toContain('[dzzzzzz.s0.p0]');
    expect(ordered).toHaveLength(1);
    expect(verifyAlignment(body, ordered)).toBe(1);
  });

  it('SHORT-ID COLLISION: two docs sharing a 6-char prefix are left raw, never misnumbered', () => {
    // makeDocShortId truncates to 6 chars — craft ids that collide.
    const dA = 'abcdef-1111-aaaa';
    const dB = 'abcdef-2222-bbbb';
    const sources = [rec(dA, 'https://ex.org/a', 'Doc A'), rec(dB, 'https://ex.org/b', 'Doc B')];
    const synthesis = `From A or B, no anchor can say [${makeDocShortId(dA)}.s0.p0].`;
    const { body } = assembleReportBody(synthesis, 't', sources);
    // The old behavior mapped this to Doc A silently — a WRONG citation for
    // any chunk that actually belongs to Doc B. Raw is honest: the chip
    // resolver answers from the chunk store, which is exact.
    expect(body).toContain(`[${makeDocShortId(dA)}.s0.p0]`);
    expect(body).not.toContain('#cite:');
  });

  it('duplicate records for one doc share a number and one Sources entry', () => {
    const dA = uuid();
    const sA = makeDocShortId(dA);
    // Same doc captured by two agents — records differ, docId is the same.
    const sources = [rec(dA, 'https://ex.org/a', 'A via web'), rec(dA, 'https://ex.org/a', 'A via news')];
    const synthesis = `One [${sA}.s0.p0] and two [${sA}.s1.p0].`;
    const { body, ordered } = assembleReportBody(synthesis, 't', sources);
    expect(verifyAlignment(body, ordered)).toBe(2);
    expect(ordered).toHaveLength(1);
    expect(body.match(/\[\[1\]/g)?.length).toBe(2);
    expect(body).not.toContain('[[2]');
  });

  it('linkify emits nothing but #cite links and raw anchors — no web-url citation can desync', () => {
    const dA = uuid();
    const sources = [rec(dA, 'https://ex.org/a_(paren)', 'A')];
    const { text } = linkifyReportCitations(`X [${makeDocShortId(dA)}.s0.p0].`, sources);
    expect(text).not.toMatch(/\]\(https?:/);
  });
});
