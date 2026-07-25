import { describe, it, expect } from 'vitest';
import { continueList } from '../list-continue';

// Caret is written as "│" in each fixture and stripped, so the tests read like
// what the user actually sees in the box.
function at(withCaret: string) {
  const caret = withCaret.indexOf('│');
  return { value: withCaret.replace('│', ''), caret };
}

describe('continueList', () => {
  it('returns null when the caret is not in a list line', () => {
    expect(continueList(...Object.values(at('just a sentence│')) as [string, number])).toBeNull();
    expect(continueList(...Object.values(at('# a heading│')) as [string, number])).toBeNull();
    expect(continueList('', 0)).toBeNull();
  });

  it('continues a numbered list, incrementing the number', () => {
    const { value, caret } = at('1. one│');
    const r = continueList(value, caret)!;
    expect(r.value).toBe('1. one\n2. ');
    expect(r.value.slice(r.caret)).toBe('');   // caret at the very end, ready to type
    expect(r.value.slice(0, r.caret)).toBe('1. one\n2. ');
  });

  it('keeps counting past 9 without resetting', () => {
    const { value, caret } = at('10. ten│');
    expect(continueList(value, caret)!.value).toBe('10. ten\n11. ');
  });

  it('continues a bullet list, repeating the marker', () => {
    for (const b of ['-', '*', '+']) {
      const { value, caret } = at(`${b} item│`);
      expect(continueList(value, caret)!.value).toBe(`${b} item\n${b} `);
    }
  });

  it('preserves indentation', () => {
    const { value, caret } = at('    - nested│');
    expect(continueList(value, caret)!.value).toBe('    - nested\n    - ');
  });

  it('ends the list when Enter is pressed on an empty item', () => {
    const { value, caret } = at('1. one\n2. │');
    const r = continueList(value, caret)!;
    // The empty "2. " marker is gone; the caret sits where it was.
    expect(r.value).toBe('1. one\n');
    expect(r.caret).toBe('1. one\n'.length);
  });

  it('ends an empty bullet item too', () => {
    const { value, caret } = at('- one\n- │');
    expect(continueList(value, caret)!.value).toBe('- one\n');
  });

  it('continues from the middle of a multi-line list, not just the end', () => {
    // Caret after "two", before the "\n3." — the next item is inserted there.
    const { value, caret } = at('1. one\n2. two│\n3. three');
    const r = continueList(value, caret)!;
    expect(r.value).toBe('1. one\n2. two\n3. \n3. three');
    expect(r.value.slice(0, r.caret).endsWith('\n3. ')).toBe(true);
  });

  it('treats a marker with no space as ordinary text (not a list)', () => {
    // "1.text" has no space after the dot — Markdown does not make it a list,
    // and neither do we.
    expect(continueList(...Object.values(at('1.text│')) as [string, number])).toBeNull();
  });

  it('clamps an out-of-range caret instead of throwing', () => {
    expect(() => continueList('- a', 999)).not.toThrow();
    expect(continueList('- a', 999)!.value).toBe('- a\n- ');
  });
});
