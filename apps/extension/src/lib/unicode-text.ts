// ─────────────────────────────────────────────
// Unicode text helpers — language-agnostic tokenization
// ─────────────────────────────────────────────
// JS's \w, \b and [a-z] classes are ASCII-only. Every tokenizer/slugger that
// used them silently broke on German umlauts, produced EMPTY keys for Japanese
// (which then collided: all non-Latin headings hashed to the same ''), and
// counted a whole CJK article as one "word". Centralize the Unicode-aware
// primitives here so each module stops re-rolling ASCII variants.

/** Lowercase word tokens: letters + digits of ANY script (ä, 漢, 日, ك…). */
export function unicodeTokens(text: string): string[] {
  return text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*/gu) || [];
}

/** Fuzzy identity key: case/strip-insensitive, keeps letters+digits of any script. */
export function unicodeKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** A CJK character that is meaningful as a single-char token. */
const CJK_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * Word tokens for scoring/matching: drops single-char Latin tokens (a, I) but
 * keeps single CJK characters, which carry meaning on their own.
 */
export function meaningfulTokens(text: string, stopwords?: Set<string>): string[] {
  return unicodeTokens(text).filter(t =>
    (t.length > 1 || CJK_CHAR_RE.test(t)) && !stopwords?.has(t)
  );
}

/** Detect the dominant script of a text (cheap Unicode-range heuristic). */
export type ScriptGuess = 'latin' | 'cjk' | 'cyrillic' | 'arabic' | 'other';
export function guessScript(text: string): ScriptGuess {
  let cjk = 0, cyr = 0, arab = 0, latin = 0;
  const sample = text.slice(0, 2000);
  for (const ch of sample) {
    if (/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/.test(ch)) cjk++;
    else if (/[Ѐ-ӿ]/.test(ch)) cyr++;
    else if (/[؀-ۿݐ-ݿ]/.test(ch)) arab++;
    else if (/[a-zA-ZÀ-ɏ]/.test(ch)) latin++;
  }
  const max = Math.max(cjk, cyr, arab, latin);
  if (max === 0) return 'other';
  if (max === cjk) return 'cjk';
  if (max === latin) return 'latin';
  if (max === cyr) return 'cyrillic';
  return 'arabic';
}
