import { describe, it, expect } from 'vitest';
import { fixSmallCapsSpacing, isFigureFragment, cleanPdfPageMarkdown } from '../pdf-text-cleaner';

describe('fixSmallCapsSpacing', () => {
  it('repairs letter-spaced small-caps headings (the real-world case)', () => {
    expect(fixSmallCapsSpacing('III. C HAIN - OF -T HOUGHT A PPROACHES IN M EDICAL AI'))
      .toBe('III. CHAIN-OF-THOUGHT APPROACHES IN MEDICAL AI');
    expect(fixSmallCapsSpacing('IV. S PECIALIZED M EDICAL R EASONING M ODELS'))
      .toBe('IV. SPECIALIZED MEDICAL REASONING MODELS');
  });

  it('never touches mixed-case prose ("A BIG deal" stays intact)', () => {
    const prose = 'This was A BIG deal for the team and everyone knew it.';
    expect(fixSmallCapsSpacing(prose)).toBe(prose);
  });

  it('leaves short lines and normal caps words alone', () => {
    expect(fixSmallCapsSpacing('A B')).toBe('A B');
    expect(fixSmallCapsSpacing('NASA AND ESA COLLABORATED')).toBe('NASA AND ESA COLLABORATED');
  });
});

describe('isFigureFragment', () => {
  it('flags braided diagram-label pseudo-paragraphs', () => {
    const braided = 'Reinforcement Learning Evaluation Frameworks and for Enhanced Reasoning Benchmarks A Sec. 7 Deepseek-R1 B Medical Reasoning Med-R1 Sec. 2 Sec. 9 Foundation A B Sec. 3 Evolution Application Chain-of-Thought Approaches Sec. 5 Multi-Agent A Approaches MDTeamGPT Sec. 10 B Layered CoT Challenges and Future Directions';
    expect(isFigureFragment(braided)).toBe(true);
  });

  it('flags short orphan label lines', () => {
    expect(isFigureFragment('A B')).toBe(true);
    expect(isFigureFragment('C D')).toBe(true);
    expect(isFigureFragment('BioMedQ&A Domain specific Sec. 4')).toBe(true);
  });

  it('keeps real prose, headings, and tables', () => {
    expect(isFigureFragment('Early medical LLMs, while proficient at tasks like answering medical questions from a knowledge base, often struggled with the sophisticated, multi-faceted diagnostic reasoning routinely performed by experienced physicians.')).toBe(false);
    expect(isFigureFragment('# Introduction')).toBe(false);
    expect(isFigureFragment('| col | col2 |')).toBe(false);
    expect(isFigureFragment('The results are shown in Sec. 4.')).toBe(false); // sentence-final ref
  });
});

describe('cleanPdfPageMarkdown', () => {
  it('collapses consecutive debris paragraphs into one marker and repairs headings', () => {
    const page = [
      'Fig. 1.',
      'A B',
      'Specialized Models A Sec. 4 B Sec. 6 Prompting and Optimization A B',
      'III. C HAIN - OF -T HOUGHT A PPROACHES',
      'Real prose paragraph that explains the chain of thought technique in detail and how clinicians use it.'
    ].join('\n\n');
    const out = cleanPdfPageMarkdown(page);
    expect(out).toContain('*(figure/diagram text omitted)*');
    expect(out.match(/figure\/diagram text omitted/g)!.length).toBe(1);
    expect(out).toContain('III. CHAIN-OF-THOUGHT APPROACHES');
    expect(out).toContain('Real prose paragraph');
    expect(out).not.toContain('Specialized Models A Sec. 4');
  });
});
