// ─────────────────────────────────────────────
// Do the numbers in a cited claim appear in the source it cites?
// ─────────────────────────────────────────────
// `lib/faithfulness.ts` states its own limit: it is RELEVANCE-grade, so it
// catches "this source isn't about this claim" but not "a wrong number pulled
// from the right chunk". It rejects an NLI model for that, and rightly — it
// would re-inflate the offscreen heap that took real effort to bound.
//
// But numbers don't need a model. A figure in a cited sentence either occurs in
// the chunk that sentence cites, or it does not, and that is string work.
//
// This is the single most damaging error the pipeline can make. A missing number
// is visible. A wrong one, carrying a citation, is invisible and spends exactly
// the credibility the citation was for — and we have already seen it happen: a
// table re-rendered into a second section had one column's values written into
// another's.
//
// Deliberately a REPORT, not a redaction. A figure can legitimately be absent
// from its chunk — rounded ("about 40%" from 0.412), converted, summed, or
// restated in different units. Deleting on that basis would corrupt good prose.
// Flagging lets the run say what it could not confirm.

/** A number worth checking, as it appeared in the prose. */
export interface Figure {
  /** Verbatim, e.g. "63.85", "71 000", "40%". */
  raw: string;
  /** Comparable form: digits and a decimal point only. */
  canonical: string;
}

export interface FigureFinding {
  figure: string;
  anchor: string;
  /** The sentence the figure and the anchor share. */
  claim: string;
}

export interface FigureCheckResult {
  checked: number;
  unverified: FigureFinding[];
}

/**
 * Figures below this are skipped. Small integers are overwhelmingly counts,
 * list positions, years-as-ordinals and prose ("three of the four studies"), and
 * they collide with everything — checking them produces noise, not signal.
 */
const MIN_INTERESTING = 10;

/**
 * Canonical form for comparison. Handles the ways the same quantity is written:
 *   "71 000" / "71,000" / "71.000" → 71000     (thin space, comma, dot grouping)
 *   "63,85"  / "63.85"             → 63.85     (European decimal comma)
 * Grouping separators are distinguished from a decimal point by what follows:
 * exactly three digits and nothing else means grouping.
 */
export function canonicalNumber(raw: string): string {
  let s = raw.replace(/[%\s   ]/g, '');
  // Grouping separators: a comma or dot followed by exactly 3 digits, repeated.
  s = s.replace(/([.,])(?=\d{3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$)/g, '');
  // Any remaining comma is a decimal comma.
  s = s.replace(',', '.');
  // Trim trailing zeros in the decimal part so 63.850 == 63.85.
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Extract checkable figures from a piece of prose. */
export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  const seen = new Set<string>();
  // A number possibly with grouping/decimal separators and an optional % sign.
  const re = /\d[\d\s   .,]*\d%?|\d+%?/g;
  for (const m of text.match(re) || []) {
    const raw = m.trim().replace(/[.,]$/, '');
    const canonical = canonicalNumber(raw);
    const value = Number(canonical);
    if (!Number.isFinite(value) || Math.abs(value) < MIN_INTERESTING) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw, canonical });
  }
  return out;
}

/**
 * Every reading of a number that is genuinely ambiguous.
 *
 * `63.850` is either 63850 (dot grouping, as German/Finnish writes it) or 63.85
 * with a trailing zero. Nothing in the string settles it. Since the job is to
 * avoid crying wolf, an ambiguous figure matches under EITHER reading — a false
 * alarm on a correct number would train the reader to ignore the flag, which
 * costs more than the miss.
 */
export function canonicalVariants(raw: string): string[] {
  const out = new Set<string>([canonicalNumber(raw)]);
  const m = /^(\d+)[.,](\d{3})%?$/.exec(raw.replace(/[\s\u00a0\u2009\u202f]/g, ''));
  if (m) {
    out.add(`${m[1]}.${m[2]}`.replace(/0+$/, '').replace(/\.$/, ''));  // decimal reading
    out.add(`${m[1]}${m[2]}`);                                          // grouping reading
  }
  return [...out];
}

/** Does `haystack` contain this figure, under any reading of either side? */
export function chunkContainsFigure(haystack: string, fig: Figure): boolean {
  if (!haystack) return false;
  if (haystack.includes(fig.raw)) return true;
  const wanted = new Set(canonicalVariants(fig.raw));
  for (const cand of haystack.match(/\d[\d\s\u00a0.,]*\d|\d+/g) || []) {
    if (canonicalVariants(cand).some(v => wanted.has(v))) return true;
  }
  return false;
}

const ANCHOR_RE = /\[([a-z0-9]+(?:\.[a-z0-9]+)+)\]|\[\d+\]\(#cite:([a-z0-9.]+)\)/gi;

/** Split into sentences, keeping anchors attached to the claim they follow. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z\p{Lu}])|\n{2,}/u)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Check every figure that shares a sentence with a citation against that
 * citation's own chunk.
 *
 * A figure is reported only when it is missing from EVERY chunk cited in its
 * sentence — a sentence citing two sources may legitimately draw the number from
 * either. `getChunkText` returning null (unknown anchor) means "cannot check",
 * never "unverified": an unresolvable anchor is a different defect with its own
 * handling.
 */
export async function checkFigures(
  text: string,
  getChunkText: (anchorId: string) => Promise<string | null>,
): Promise<FigureCheckResult> {
  const unverified: FigureFinding[] = [];
  let checked = 0;
  const cache = new Map<string, string | null>();

  const chunkFor = async (a: string): Promise<string | null> => {
    if (!cache.has(a)) cache.set(a, await getChunkText(a).catch(() => null));
    return cache.get(a) ?? null;
  };

  for (const sentence of sentences(text)) {
    const anchors = [...sentence.matchAll(ANCHOR_RE)].map(m => m[1] || m[2]).filter(Boolean) as string[];
    if (anchors.length === 0) continue;
    // Strip the anchors themselves — `[d3ab01.s1.p2]` contains digits.
    const prose = sentence.replace(ANCHOR_RE, ' ');
    const figures = extractFigures(prose);
    if (figures.length === 0) continue;

    const texts = (await Promise.all(anchors.map(chunkFor))).filter((t): t is string => !!t);
    if (texts.length === 0) continue;   // nothing resolved — cannot check

    for (const fig of figures) {
      checked++;
      if (!texts.some(t => chunkContainsFigure(t, fig))) {
        unverified.push({ figure: fig.raw, anchor: anchors[0], claim: sentence.slice(0, 160) });
      }
    }
  }
  return { checked, unverified };
}
