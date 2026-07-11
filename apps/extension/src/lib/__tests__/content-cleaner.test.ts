import { describe, it, expect } from 'vitest';
import { cleanContent } from '../content-cleaner';

// ─── invisible unicode ───────────────────────────────────────────────────────

describe('cleanContent — invisible unicode', () => {
  it('strips BOM, zero-width spaces, and soft-hyphen', () => {
    const input = '\uFEFFHello\u200B \u200CWorld\u00AD!';
    const result = cleanContent(input);
    expect(result).not.toMatch(/[\uFEFF\u200B\u200C\u00AD]/);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('strips LTR/RTL marks and other invisible chars', () => {
    const input = 'Text\u200E with\u200F marks\u2060 here\u180E.';
    const result = cleanContent(input);
    expect(result).not.toMatch(/[\u200E\u200F\u2060\u180E]/);
    expect(result).toContain('Text');
    expect(result).toContain('with marks here');
  });
});
