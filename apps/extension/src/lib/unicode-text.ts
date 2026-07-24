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

// ── Invisible characters ─────────────────────────────────────────────────
// Two sets, deliberately different, because "safe to drop" depends on WHERE.

/**
 * Unicode INVISIBLE OPERATORS — U+2061 FUNCTION APPLICATION, U+2062 INVISIBLE
 * TIMES, U+2063 INVISIBLE SEPARATOR, U+2064 INVISIBLE PLUS. They encode math
 * *semantics* and have no glyph; MathML pages, PDF text extraction and some
 * models emit them. KaTeX ships no font metrics for them, so every one that
 * reaches the renderer logs `No character metrics for '<U+2061>' in style
 * 'Main-Regular'` and renders a zero-width node.
 *
 * Removing them changes nothing a reader can see, which is why this is safe on
 * ANY display text — chat messages, code spans, emoji included. The wider
 * scrape-time set below is not.
 */
export function stripInvisibleMathOps(text: string): string {
  return text.replace(/[\u2061-\u2064]/gu, '');
}

/**
 * The wider set stripped from SCRAPED page text: zero-width space/joiners,
 * direction marks, soft hyphen, BOM, Mongolian vowel separator.
 *
 * Fine on boilerplate-laden HTML; NOT safe on arbitrary user text — U+200D
 * joins emoji families (👨‍👩‍👧) and U+200C is load-bearing in Persian and
 * several Indic scripts. Keep this on the ingest path only.
 */
export function stripInvisibleChars(text: string): string {
  return stripInvisibleMathOps(text)
    .replace(/[\u200B-\u200F\u2060\u00AD\u180E\uFEFF]/gu, '');
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
