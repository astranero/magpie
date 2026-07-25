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


/**
 * Remove anchor-shaped brackets that can never resolve.
 *
 * A real citation anchor is `d<6 hex>.s<n>.p<n>` — the doc short id
 * (`makeDocShortId` = 'd' + first 6 chars of the uuid) plus a section and
 * paragraph. `linkifyReportCitations` deliberately leaves an UNRESOLVED but
 * well-formed anchor alone, because the renderer looks it up in the chunk store
 * at display time and may well find it.
 *
 * A bare `[d7c0864]` is different: no section, no paragraph, so it cannot
 * address a chunk under any circumstances. One shipped in a live report and
 * rendered as literal noise the reader could neither click nor act on — the
 * model had invented a doc id and stopped there.
 *
 * Matched narrowly on purpose: `d` + 5-8 hex digits and nothing else. `[note]`,
 * `[1]` and `[W3]` are untouched.
 */
export function stripUnresolvableAnchors(text: string): string {
  return (text || '')
    // Drop a preceding space too, so removal doesn't leave "word  ." gaps.
    .replace(/ ?\[d[0-9a-f]{5,8}\]/gi, '')
    .replace(/ +([.,;:])/g, '$1');
}


/**
 * A table's identity: its header cells, normalised. Numbers are what get
 * corrupted, so identity must NOT include them.
 */
function tableSignature(headerRow: string): string {
  return headerRow
    .split('|').map(c => c.trim().toLowerCase()).filter(Boolean)
    .join('|');
}

interface FoundTable { start: number; end: number; signature: string; cols: number }

/** Locate every markdown table: a header row, a delimiter row, then body rows. */
function findTables(lines: string[]): FoundTable[] {
  const out: FoundTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isTableRow(lines[i]) || isTableDelimiter(lines[i])) continue;
    if (!isTableDelimiter(lines[i + 1])) continue;
    let end = i + 2;
    while (end < lines.length && isTableRow(lines[end])) end++;
    const sig = tableSignature(lines[i]);
    out.push({ start: i, end, signature: sig, cols: sig.split('|').length });
    i = end - 1;
  }
  return out;
}

/**
 * Drop a table that repeats one already present earlier in the report.
 *
 * Sectioned synthesis lets a chunk feed TWO sections, so the same source table
 * can be written twice — and the second rendering is reconstructed rather than
 * copied. Observed live: an interaction-mode table appeared in two sections, and
 * in the second the ENGAGEMENT column had been written into the USABILITY
 * column, so Text/Complex read 73.6 where the source says 63.85.
 *
 * A duplicated table is redundant. A duplicated table with different numbers is
 * worse than either copy alone: the reader cannot tell which is right, and a
 * cited report that contradicts itself on a figure has lost the thing it was
 * for. The first copy is kept — it is written by the section that retrieved the
 * chunk with the strongest match.
 *
 * Identity is the header row only, never the numbers, so a corrupted copy is
 * still recognised as the same table. Guarded against collapsing genuinely
 * different tables: at least 3 columns and a header with real words, so a
 * generic `| Metric | Value |` pair is left alone.
 */
export function dropDuplicateTables(text: string): string {
  const lines = (text || '').split('\n');
  const tables = findTables(lines);
  if (tables.length < 2) return text;

  const seen = new Set<string>();
  const cut: Array<[number, number]> = [];
  for (const t of tables) {
    const specific = t.cols >= 3 && t.signature.replace(/[^a-z]/g, '').length >= 12;
    if (!specific) continue;
    if (seen.has(t.signature)) cut.push([t.start, t.end]);
    else seen.add(t.signature);
  }
  if (!cut.length) return text;

  const drop = new Set<number>();
  for (const [a, b] of cut) for (let i = a; i < b; i++) drop.add(i);
  return lines
    .filter((_, i) => !drop.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ─────────────────────────────────────────────
// Stub code blocks — remove code that only gestures at logic
// ─────────────────────────────────────────────
// A study of a real report caught a four-line "DFS stub" whose whole body was
// `# DFS traversal logic to detect cyclic back-edges` — it looks like code,
// signals "engineering happened", and shows nothing. The prompt now forbids it;
// this guarantees it. A fenced block is dropped ONLY when its body carries no
// real statement: nothing but comments, ellipses, `pass`, and a phrase that
// gestures at omitted work. Anything with an actual line of code is kept —
// conservative by design, because a wrongly-dropped real snippet is worse than
// a surviving stub.

const GESTURE = /\b(logic|implementation|algorithm|traversal|code|details?|rest of|goes here|omitted|todo|tbd|pseudo-?code|and so on|etc\.)\b/i;

function isStubBody(body: string): boolean {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  let sawGesture = false;
  for (const l of lines) {
    const isComment = /^(#|\/\/|\/\*|\*|--|;)/.test(l);
    const isFiller = /^(\.\.\.|…|pass|\{\s*\}|\{|\})$/.test(l);
    if (isComment || isFiller) {
      if (GESTURE.test(l)) sawGesture = true;
      continue;
    }
    return false;   // a real, non-comment, non-filler line → not a stub
  }
  // Only a stub if every line was comment/filler AND at least one gestured at
  // work that isn't there. A block of pure `...` with no gesture is left alone.
  return sawGesture;
}

/**
 * Drop fenced code blocks whose body is nothing but a comment gesturing at
 * logic that isn't shown. Real code — even one line of it — is always kept.
 */
export function stripStubCodeBlocks(text: string): string {
  const src = text || '';
  // Match a fenced block: ```lang\n ... \n```
  return src.replace(/```[^\n]*\n([\s\S]*?)```/g, (full, body: string) =>
    isStubBody(body) ? '' : full,
  ).replace(/\n{3,}/g, '\n\n');
}

// ─────────────────────────────────────────────
// Broken formulas — a half-rendered equation is worse than none
// ─────────────────────────────────────────────
// Rich-text math (LaTeX, superscripts) that didn't survive to plain text leaves
// holes: "Where  is a tunable parameter", "Let  represent a directed graph
// where  is the set of tasks" — the variables dropped out, leaving a doubled
// space where a symbol should be. The reader sees a sentence that references a
// variable that isn't there. Rather than guess the math, replace the maimed
// clause's gap with a marker so the report degrades honestly.

/**
 * Repair a sentence that lost its math variable to a rendering gap. Targets the
 * specific shape seen live — "Where/Let/where/is <space><space> is/represent…" —
 * and an empty `$…$`/`\( \)` span. Conservative: only acts on a clearly-empty
 * slot, never rewrites real math.
 */
export function flagBrokenFormula(text: string): string {
  let out = text || '';
  // Empty inline-math spans: $  $, \(  \), $$  $$ with only whitespace inside.
  out = out.replace(/\$\$?\s*\$\$?/g, '[formula omitted — see source]');
  out = out.replace(/\\\(\s*\\\)/g, '[formula omitted — see source]');
  // A dropped variable after Where/Let/and/where leaves "Word␣␣is/represent/be".
  out = out.replace(
    /\b(Where|Let|And|where|let)\s{2,}(is|are|be|represents?|denotes?)\b/g,
    '$1 [symbol omitted] $2',
  );
  return out;
}
