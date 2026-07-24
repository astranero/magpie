// ─────────────────────────────────────────────
// Report section split/join + citation accounting (pure)
// ─────────────────────────────────────────────
// A whole-report rewrite is how citations get lost: the reviser is told to
// "expand and restructure", and an LLM restructuring 3000 words drops most
// inline [anchor] markers even when told to keep them. Splitting the report
// lets a revision touch ONLY the section the auditor flagged and leave every
// other section byte-identical — citations included.
//
// Pure and dependency-free so the invariants are unit-testable.

export interface ReportSection {
  /** The heading line verbatim, including its `## ` prefix. */
  heading: string;
  /** Everything between this heading and the next one. */
  body: string;
}

export interface SplitReport {
  /** Text before the first `##` heading (exec overview) — never revised. */
  preamble: string;
  sections: ReportSection[];
}

/** Inline chunk-anchor citation, raw `[d3ab01.s1.p2]` or linkified `(#cite:…)`. */
const CITATION_RE = /\[[a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?\]|\(#cite:[a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?\)/gi;

/** How many chunk citations a piece of report text carries. */
export function countCitations(text: string): number {
  return (text || '').match(CITATION_RE)?.length ?? 0;
}

/**
 * Split a report on its `##` headings. `###` and deeper stay inside their
 * parent section's body — only top-level sections are independently revisable.
 */
export function splitReportSections(text: string): SplitReport {
  const lines = (text || '').split('\n');
  const preambleLines: string[] = [];
  const sections: ReportSection[] = [];
  let current: ReportSection | null = null;

  for (const line of lines) {
    // `## Heading` but not `### Heading`
    if (/^##[^#]/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line, body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble: preambleLines.join('\n'), sections };
}

/** Inverse of splitReportSections — round-trips byte-identically. */
export function joinReportSections(preamble: string, sections: ReportSection[]): string {
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  for (const s of sections) parts.push(s.body ? `${s.heading}\n${s.body}` : s.heading);
  return parts.join('\n');
}

/** Normalize a heading for comparison: drop `#`, punctuation, case, spacing. */
function normalizeHeading(s: string): string {
  return (s || '')
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does an auditor's `flaggedSections` entry refer to this heading? The auditor
 * writes free text ("the Trade-offs section", "Trade-offs"), so match on
 * containment either way rather than equality — but require a real overlap so
 * a one-word flag can't sweep the whole report.
 */
export function sectionMatchesFlag(heading: string, flag: string): boolean {
  const h = normalizeHeading(heading);
  const f = normalizeHeading(flag);
  if (!h || !f) return false;
  if (h === f) return true;
  // Containment, but only when the shorter side carries enough signal to be
  // specific — "the" or "and" must never match every section.
  const shorter = h.length <= f.length ? h : f;
  if (shorter.length < 4) return false;
  return h.includes(f) || f.includes(h);
}

/**
 * Accept a revised section only if it didn't gut the citations. An LLM
 * rewrite that keeps the prose but drops the evidence is worse than the
 * original — this is the exact failure that produced link-free reports.
 * Losing a citation or two while restructuring is normal; losing most is not.
 */
export function revisionKeptCitations(originalBody: string, revisedBody: string): boolean {
  const before = countCitations(originalBody);
  if (before === 0) return true;              // nothing to lose
  return countCitations(revisedBody) >= Math.ceil(before / 2);
}
