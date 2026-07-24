// ─────────────────────────────────────────────
// Repairing model output before it reaches the reader
// ─────────────────────────────────────────────
// Two ways a report arrives broken, both seen live:
//
// 1. The capstone's DELIMITERS leak. The prompt asks for three blocks split by
//    `---CONTRADICTIONS---` and `---VERDICT---`. A model wrote
//    `---CONTRADICTIONS & OPEN QUESTIONS---` — echoing the section's full name —
//    so an exact-match split found nothing, the heading-based fallback found no
//    `## Contradictions` either (the model used the delimiter line INSTEAD of a
//    heading), and the entire capstone was treated as the executive overview.
//    The reader got raw `---VERDICT---` lines at the top of the report and no
//    Verdict section at the bottom.
//
//    Fixing the prompt is not enough on its own: the parser has to survive a
//    model that paraphrases, because some always will.
//
// 2. Generation stops MID-STRUCTURE. A section ended on
//    `| Feature Area | User Perception/Behavioral Correlate` — a table header
//    cut off before its delimiter row, which renders as a stray line of pipes.
//    The cause is upstream (an output cap), but shipping the fragment is a
//    choice, and the wrong one.

/** A `---SOMETHING---` fence line, however the model padded the name. */
const FENCE_RE = /^\s*-{2,}\s*([A-Z][A-Z\s&'’]*?)\s*-{2,}\s*$/;

export interface CapstoneParts {
  exec: string;
  contradictions: string;
  verdict: string;
}

/**
 * Split the capstone into its three blocks.
 *
 * Accepts the exact delimiters, paraphrased ones (`---CONTRADICTIONS & OPEN
 * QUESTIONS---`), and plain `##` headings — whichever the model produced. A
 * fence line is classified by the KEYWORD it contains, not by matching the
 * whole string, which is what made the original parser brittle.
 *
 * Blocks are returned without their fence lines; the caller supplies canonical
 * headings, so a paraphrased fence can never reach the reader.
 */
export function splitCapstone(raw: string): CapstoneParts {
  const text = (raw || '').trim();
  if (!text) return { exec: '', contradictions: '', verdict: '' };

  type Bucket = 'exec' | 'contradictions' | 'verdict';
  const buckets: Record<Bucket, string[]> = { exec: [], contradictions: [], verdict: [] };
  let current: Bucket = 'exec';

  for (const line of text.split('\n')) {
    const fence = FENCE_RE.exec(line);
    const headingMatch = /^\s*#{1,4}\s*(.+?)\s*$/.exec(line);
    const label = (fence?.[1] || headingMatch?.[1] || '').toUpperCase();

    if (label && /CONTRADICTION|OPEN QUESTION/.test(label)) { current = 'contradictions'; continue; }
    if (label && /\bVERDICT\b|RECOMMENDATION/.test(label)) { current = 'verdict'; continue; }

    // A fence we don't recognise is still a fence — never show it to a reader.
    if (fence) continue;
    buckets[current].push(line);
  }

  const clean = (lines: string[]) => lines.join('\n').trim();
  return {
    exec: clean(buckets.exec),
    contradictions: clean(buckets.contradictions),
    verdict: clean(buckets.verdict),
  };
}

/** Does this line look like a markdown table row? */
const isTableRow = (l: string) => /^\s*\|.*\|?\s*$/.test(l) && l.includes('|');
/** The `|---|---|` line that makes the rows above it a table. */
const isTableDelimiter = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

/**
 * Drop a trailing fragment left by generation stopping mid-structure.
 *
 * Removes, from the end only:
 *   • a table that never got its delimiter row (header alone renders as pipes),
 *   • a heading with nothing under it,
 *   • a final line that breaks off mid-sentence — no terminal punctuation, and
 *     long enough that it was clearly meant to continue.
 *
 * Conservative by design: it takes at most a few trailing lines and never
 * touches the body. A cut report that ends slightly early is fine; one that
 * ends in visible debris is not.
 */
export function trimTruncatedTail(text: string): string {
  let lines = (text || '').replace(/\s+$/, '').split('\n');

  for (let guard = 0; guard < 4; guard++) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) break;
    const last = lines[lines.length - 1];

    // Table header with no delimiter row beneath it → not a table, just pipes.
    if (isTableRow(last)) {
      let i = lines.length - 1;
      while (i >= 0 && isTableRow(lines[i])) i--;
      const rows = lines.slice(i + 1);
      if (!rows.some(isTableDelimiter)) { lines = lines.slice(0, i + 1); continue; }
      // A real table whose LAST row is the delimiter is also incomplete.
      if (isTableDelimiter(rows[rows.length - 1])) { lines = lines.slice(0, i + 1); continue; }
      break;
    }

    // A heading with no content under it.
    if (/^\s*#{1,6}\s+\S/.test(last)) { lines.pop(); continue; }

    // Broken off mid-sentence. Short lines are left alone: a label, a list item
    // or a closing fragment legitimately lacks a full stop.
    const t = last.trim();
    if (t.length > 40 && !/[.!?:;)"'`\]]$/.test(t) && !/^[-*+>|]/.test(t)) { lines.pop(); continue; }

    break;
  }

  return lines.join('\n').replace(/\s+$/, '');
}
