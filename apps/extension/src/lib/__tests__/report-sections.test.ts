import { describe, it, expect } from 'vitest';
import {
  splitReportSections, joinReportSections, countCitations,
  sectionMatchesFlag, revisionKeptCitations,
} from '../report-sections';

// These back the section-scoped revision. The property that matters: revising
// one section must leave every OTHER section byte-identical, citations included
// — a whole-report rewrite losing citations is what produced link-free reports.

const REPORT = `Executive overview paragraph with a citation [d3ab01.s0.p0].

## Findings
Claim one [d3ab01.s1.p2]. Claim two [dbb2200.s0.p1].

### A subheading stays inside its parent
More detail here.

## Trade-offs
Only one citation here [d3ab01.s2.p0].

## Verdict
No citations in this one.`;

describe('splitReportSections', () => {
  it('separates preamble from top-level sections', () => {
    const { preamble, sections } = splitReportSections(REPORT);
    expect(preamble).toContain('Executive overview');
    expect(sections.map(s => s.heading)).toEqual(['## Findings', '## Trade-offs', '## Verdict']);
  });

  it('keeps ### subheadings inside their parent section', () => {
    const { sections } = splitReportSections(REPORT);
    expect(sections[0].body).toContain('### A subheading stays inside');
    expect(sections.some(s => s.heading.startsWith('###'))).toBe(false);
  });

  it('round-trips byte-identically — the core safety property', () => {
    const { preamble, sections } = splitReportSections(REPORT);
    expect(joinReportSections(preamble, sections)).toBe(REPORT);
  });

  it('handles a report with no sections at all', () => {
    const flat = 'Just prose, no headings.';
    const { preamble, sections } = splitReportSections(flat);
    expect(sections).toHaveLength(0);
    expect(joinReportSections(preamble, sections)).toBe(flat);
  });

  it('replacing ONE section leaves the others untouched', () => {
    const { preamble, sections } = splitReportSections(REPORT);
    const before = sections[2].body;
    sections[1] = { ...sections[1], body: 'Rewritten trade-offs [d3ab01.s2.p0].' };
    const out = joinReportSections(preamble, sections);
    expect(out).toContain('Rewritten trade-offs');
    expect(out).toContain('Claim one [d3ab01.s1.p2]');   // Findings intact
    expect(sections[2].body).toBe(before);                // Verdict intact
  });
});

describe('countCitations', () => {
  it('counts raw anchors and linkified #cite forms', () => {
    expect(countCitations('a [d3ab01.s1.p2] b [dbb2200.s0.p1]')).toBe(2);
    expect(countCitations('a [[1](#cite:d3ab01.s1.p2)]')).toBe(1);
    expect(countCitations('four-part anchor [d3ab01.s1.p2.0]')).toBe(1);
  });

  it('does not count ordinary brackets or markdown links', () => {
    expect(countCitations('see [the docs](https://x.org) and [note]')).toBe(0);
    expect(countCitations('')).toBe(0);
  });
});

describe('sectionMatchesFlag', () => {
  it('matches exact and free-text auditor phrasing', () => {
    expect(sectionMatchesFlag('## Trade-offs', 'Trade-offs')).toBe(true);
    expect(sectionMatchesFlag('## Trade-offs', 'the Trade-offs section')).toBe(true);
    expect(sectionMatchesFlag('## Key Findings', 'key findings')).toBe(true);
  });

  it('does not match an unrelated section', () => {
    expect(sectionMatchesFlag('## Verdict', 'Trade-offs')).toBe(false);
  });

  it('refuses to match on a too-short/low-signal flag — must not sweep the report', () => {
    expect(sectionMatchesFlag('## Trade-offs', 'the')).toBe(false);
    expect(sectionMatchesFlag('## Trade-offs', '')).toBe(false);
  });
});

describe('revisionKeptCitations — the guard on the actual bug', () => {
  it('accepts a revision that keeps its citations', () => {
    expect(revisionKeptCitations('a [d1.s0.p0] b [d1.s0.p1]', 'rewritten [d1.s0.p0] and [d1.s0.p1]')).toBe(true);
  });

  it('tolerates losing one of four while restructuring', () => {
    const before = '[d1.s0.p0] [d1.s0.p1] [d1.s0.p2] [d1.s0.p3]';
    expect(revisionKeptCitations(before, '[d1.s0.p0] [d1.s0.p1] [d1.s0.p2]')).toBe(true);
  });

  it('REJECTS a revision that gutted the citations', () => {
    const before = '[d1.s0.p0] [d1.s0.p1] [d1.s0.p2] [d1.s0.p3]';
    expect(revisionKeptCitations(before, 'nice prose, no evidence')).toBe(false);
    expect(revisionKeptCitations(before, 'only [d1.s0.p0] survived')).toBe(false);
  });

  it('accepts anything when the original had no citations to lose', () => {
    expect(revisionKeptCitations('no citations here', 'still none')).toBe(true);
  });
});
