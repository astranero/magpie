import { describe, it, expect } from 'vitest';
import { cleanAcademicText } from '../content-cleaner';

describe('cleanAcademicText', () => {
  it('returns full text with no references if none', () => {
    const input = '# Title\n\nSome body text without reference section.';
    const { body, references } = cleanAcademicText(input);
    expect(references).toBeNull();
    expect(body).toBe(input);
  });

  it('extracts references section with ## References heading', () => {
    const input = '# Title\n\nBody text.\n\n## References\n[1] Author A.\n[2] Author B.';
    const { body, references } = cleanAcademicText(input);
    expect(references ?? '').toContain('Author A');
    expect(references ?? '').toContain('Author B');
    expect(body).not.toContain('Author A');
  });

  it('treats References heading in mixed case', () => {
    const input = '# Title\n\nText\n\n## REFERENCES\n[1] One\n[2] Two';
    const { body, references } = cleanAcademicText(input);
    expect(references ?? '').toContain('One');
    expect(body).not.toContain('One');
  });

  it('extracts references section with plain text References line', () => {
    const input = '# Title\n\nText\n\nReferences\n[1] Ref One\n[2] Ref Two';
    const { body, references } = cleanAcademicText(input);
    expect(references ?? '').toContain('Ref One');
    expect(body).not.toContain('Ref One');
  });

  it('does not split if references block shorter than 100 chars', () => {
    const input = '# Title\n\nText';
    const { body, references } = cleanAcademicText(input);
    expect(references).toBeNull();
    expect(body).toContain('Text');
  });

  it('extracts bibliography heading', () => {
    const input = '\nText\n\n# Bibliography\n[1] Bib One\n[2] Bib Two';
    const { body, references } = cleanAcademicText(input);
    expect(references ?? '').toContain('Bib One');
    expect(body).not.toContain('Bib One');
  });

  it('does not truncate if no references heading', () => {
    const input = '# Hello\n\nNo reference headers here';
    const { body, references } = cleanAcademicText(input);
    expect(references).toBeNull();
    expect(body).toBe(input);
  });

  it('does not split if word References in body', () => {
    const input = '# Title\n\nThis is a sentence referencing other works, see references in text.';
    const { body, references } = cleanAcademicText(input);
    expect(references).toBeNull();
    expect(body).toBe(input);
  });
});
