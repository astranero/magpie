// ─────────────────────────────────────────────
// PDF extraction cleaner — deterministic post-pass (pure)
// ─────────────────────────────────────────────
// pdf.js text extraction of academic papers has two chronic artifacts that
// survive the column-aware line builder:
//
// 1. Small-caps headings arrive letter-spaced: LaTeX small caps render the
//    first letter in a larger font, so extraction yields
//    "III. C HAIN - OF -T HOUGHT A PPROACHES IN M EDICAL AI".
// 2. Figure/diagram text gets braided into the body: a full-width figure's
//    labels ("Sec. 7", "A", "B", box titles) share Y-coordinates and are
//    joined into pseudo-paragraphs of scattered fragments.
//
// Both are fixed here with pure text heuristics so capture, research, and
// preview paths all benefit — and so the rules are unit-testable.

/**
 * Re-join letter-spaced small-caps words — ONLY on lines that are
 * caps-dominant, so prose like "A BIG deal" is never touched.
 *   "C HAIN - OF -T HOUGHT A PPROACHES" → "CHAIN-OF-THOUGHT APPROACHES"
 */
export function fixSmallCapsSpacing(text: string): string {
  return text.split('\n').map(line => {
    // Unicode letter classes so German caps (ÄÖÜ) are handled too.
    const letters = line.replace(/[^\p{L}]/gu, '');
    if (letters.length < 6) return line;
    const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
    if (upper / letters.length < 0.7) return line;

    let out = line;
    // "C HAIN" → "CHAIN" (single capital + spaced caps word), repeat for chains
    let prev = '';
    while (prev !== out) {
      prev = out;
      out = out.replace(/(^|[^\p{L}\p{N}])(\p{Lu}) (?=\p{Lu}{2,})/gu, '$1$2');
    }
    // "CHAIN - OF" / "OF -THOUGHT" → hyphens re-tightened between caps words
    out = out.replace(/(\p{Lu}) *- *(?=\p{Lu})/gu, '$1-');
    return out;
  }).join('\n');
}

const SECFIG_RE = /\b(?:Sec|Fig|Tab|Eq|Abb|Kap|Kuva|Taulukko)s?\.?\s*\d*|(?:図|表)\s*\d+/g;

/**
 * Score a paragraph for "diagram debris": isolated capital letters (subfigure
 * labels) and Sec./Fig. cross-references packed between disconnected words.
 */
export function figureFragmentScore(paragraph: string): number {
  const tokens = paragraph.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const isolatedCaps = tokens.filter(t => /^\p{Lu}[.,)]?$/u.test(t)).length;
  const secRefs = (paragraph.match(SECFIG_RE) || []).length;
  return (isolatedCaps + 2 * secRefs) / tokens.length;
}

/** True when a paragraph is figure/diagram text rather than prose. */
export function isFigureFragment(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p || p.startsWith('#') || p.startsWith('|')) return false;
  const tokens = p.split(/\s+/).filter(Boolean);

  // Long pseudo-paragraphs of braided diagram labels
  if (tokens.length >= 8) return figureFragmentScore(p) > 0.18;

  // Short orphan lines: "A B", "C D", "BioMedQ&A Domain specific Sec. 4"
  if (tokens.length <= 7) {
    const isolatedCaps = tokens.filter(t => /^\p{Lu}[.,)]?$/u.test(t)).length;
    const hasSecRef = SECFIG_RE.test(p); SECFIG_RE.lastIndex = 0;
    if (isolatedCaps === tokens.length) return true;                  // "A B"
    // Diagram callouts reference sections without ending as a sentence;
    // prose that mentions "Sec. 4" ends with punctuation and survives.
    if (hasSecRef && !/[.!?:;。！？]$/.test(p)) return true;
  }
  return false;
}

const OMITTED_MARK = '*(figure/diagram text omitted)*';

/**
 * Clean one page of extracted PDF markdown: repair small-caps headings, then
 * replace diagram-debris paragraphs with a single omission marker (runs of
 * consecutive debris collapse into one marker).
 */
export function cleanPdfPageMarkdown(pageMarkdown: string): string {
  const repaired = fixSmallCapsSpacing(pageMarkdown);
  const paragraphs = repaired.split(/\n\n+/);
  const out: string[] = [];
  for (const para of paragraphs) {
    if (isFigureFragment(para)) {
      if (out[out.length - 1] !== OMITTED_MARK) out.push(OMITTED_MARK);
    } else {
      out.push(para);
    }
  }
  return out.join('\n\n');
}
