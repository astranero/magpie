import { describe, it, expect } from 'vitest';
import { generateBibtex, makeBibKey, formatBibAuthors } from '../bibtex';

describe('formatBibAuthors', () => {
  it('converts to surname-first, "and"-joined', () => {
    expect(formatBibAuthors('Ada Lovelace, Alan M. Turing')).toBe('Lovelace, Ada and Turing, Alan M.');
  });
  it('handles single-word names', () => {
    expect(formatBibAuthors('Plato')).toBe('Plato');
  });
});

describe('makeBibKey', () => {
  it('builds surname+year+firstword, skipping stopwords', () => {
    expect(makeBibKey({ title: 'The Evolution of Algorithms', authors: 'Ada Lovelace', year: '2024' }))
      .toBe('lovelace2024evolution');
  });
  it('survives missing fields', () => {
    expect(makeBibKey({ title: '' })).toBe('unknownuntitled');
  });
});

describe('generateBibtex', () => {
  it('emits @article for journals with doi and escaped title', () => {
    const bib = generateBibtex({
      title: 'Learning & Optimization {at} Scale',
      authors: 'Ada Lovelace',
      year: '2024',
      doi: '10.1145/123.456',
      venue: 'Journal of Important Results'
    });
    expect(bib).toContain('@article{lovelace2024learning');
    expect(bib).toContain('journal = {Journal of Important Results}');
    expect(bib).toContain('doi = {10.1145/123.456}');
    expect(bib).toContain('\\&');
    expect(bib).toContain('\\{at\\}');
  });

  it('emits @inproceedings with booktitle for conferences', () => {
    const bib = generateBibtex({
      title: 'A Paper',
      authors: 'Alan Turing',
      year: '2023',
      venue: 'Proceedings of the Genetic and Evolutionary Computation Conference'
    });
    expect(bib).toContain('@inproceedings{turing2023paper');
    expect(bib).toContain('booktitle = {Proceedings of the Genetic');
    expect(bib).not.toContain('journal =');
  });

  it('omits absent fields', () => {
    const bib = generateBibtex({ title: 'Solo' });
    expect(bib).not.toContain('author =');
    expect(bib).not.toContain('year =');
    expect(bib).not.toContain('doi =');
  });
});
