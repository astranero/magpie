import { describe, it, expect } from 'vitest';
import { stripInvisibleMathOps, stripInvisibleChars } from '../unicode-text';
import { cleanContent } from '../content-cleaner';

// U+2061..U+2064 are the Unicode "invisible operators". They arrive via MathML
// pages, PDF text extraction and model output, and KaTeX has no font metrics for
// any of them — each one that reaches the renderer logs
//   No character metrics for '⁡' in style 'Main-Regular' and mode 'text'
const FN_APPLY = '⁡';   // FUNCTION APPLICATION — the one seen in the wild
const INV_TIMES = '⁢';
const INV_SEP = '⁣';
const INV_PLUS = '⁤';

describe('stripInvisibleMathOps', () => {
  it('removes every invisible operator in the family', () => {
    expect(stripInvisibleMathOps(`f${FN_APPLY}(x)`)).toBe('f(x)');
    expect(stripInvisibleMathOps(`2${INV_TIMES}x`)).toBe('2x');
    expect(stripInvisibleMathOps(`a${INV_SEP}b`)).toBe('ab');
    expect(stripInvisibleMathOps(`1${INV_PLUS}2`)).toBe('12');
  });

  it('strips them inside math delimiters — the actual failing path', () => {
    expect(stripInvisibleMathOps(`$f${FN_APPLY}(x) = x^2$`)).toBe('$f(x) = x^2$');
  });

  it('leaves visible text byte-identical', () => {
    const text = 'Ordinary prose with $x^2$, `code`, ümlauts, 日本語 and 12 + 3.';
    expect(stripInvisibleMathOps(text)).toBe(text);
  });

  it('does NOT touch emoji ZWJ sequences or ZWNJ', () => {
    // U+200D joins the family emoji; U+200C is load-bearing in Persian/Indic.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(stripInvisibleMathOps(family)).toBe(family);
    expect(stripInvisibleMathOps('‌')).toBe('‌');
  });

  it('handles empty input', () => {
    expect(stripInvisibleMathOps('')).toBe('');
  });
});

describe('stripInvisibleChars (ingest path)', () => {
  it('covers the math operators too, so the two sets cannot drift', () => {
    expect(stripInvisibleChars(`f${FN_APPLY}(x)`)).toBe('f(x)');
  });

  it('also removes BOM, zero-width space, direction marks and soft hyphen', () => {
    expect(stripInvisibleChars('﻿head')).toBe('head');
    expect(stripInvisibleChars('a​b‎c­d')).toBe('abcd');
  });
});

describe('cleanContent keeps stripping what it always did', () => {
  it('drops the invisible set from scraped markdown', () => {
    expect(cleanContent('﻿Title​ text')).toContain('Title text');
  });

  it('now also drops invisible math operators from scraped markdown', () => {
    expect(cleanContent(`sin${FN_APPLY}(θ)`)).not.toContain(FN_APPLY);
  });
});
