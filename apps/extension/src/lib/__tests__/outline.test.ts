import { describe, it, expect } from 'vitest';
import {
  parseReflect, mergeOutlines, trimOutline, formatOutlineSkeleton,
  formatHandoff, selectBriefExcerpts, sectionQueriesFallback,
  type ResearchOutline, type OutlineSection,
} from '../outline';

const sec = (id: string, heading: string, over?: Partial<OutlineSection>): OutlineSection => ({
  id, heading, goal: `Goal for ${heading}`, keyTerms: [], evidenceNotes: [], status: 'thin', ...over,
});

const goodReflect = JSON.stringify({
  outline: { sections: [
    { id: 's1', heading: 'Streaming trade-offs', goal: 'Establish costs', keyTerms: ['streaming', 'latency'], evidenceNotes: ['Streaming raises load [d1.s1.p1]'], status: 'adequate' },
    { id: 's2', heading: 'Optimistic UI risks', goal: 'Map failure modes', keyTerms: ['optimistic'], evidenceNotes: [], status: 'empty' },
  ] },
  handoff: { establishedFacts: ['fact A [d1.s1.p1]'], openGaps: ['gap B'], contradictions: [], focusNext: 'chase gap B' },
  queries: ['optimistic ui rollback failures', 'skeleton screen deception study'],
});

describe('parseReflect', () => {
  it('parses clean strict JSON', () => {
    const r = parseReflect(goodReflect)!;
    expect(r.outline.sections).toHaveLength(2);
    expect(r.outline.sections[0].id).toBe('s1');
    expect(r.handoff.establishedFacts).toEqual(['fact A [d1.s1.p1]']);
    expect(r.queries).toHaveLength(2);
  });

  it('survives markdown fences and surrounding prose', () => {
    const r = parseReflect('Here is the JSON:\n```json\n' + goodReflect + '\n```\nDone.');
    expect(r?.outline.sections).toHaveLength(2);
  });

  it('repairs trailing commas and smart quotes', () => {
    const damaged = '{"outline":{"sections":[{"id":"s1","heading":“Heading”,"status":"thin",},]},"queries":["some query here",],}';
    const r = parseReflect(damaged)!;
    expect(r.outline.sections[0].heading).toBe('Heading');
    expect(r.queries).toEqual(['some query here']);
  });

  it('coerces bad fields: missing id → positional+heading-derived, bad status → thin, short queries dropped', () => {
    const r = parseReflect(JSON.stringify({
      sections: [{ heading: 'Only heading', status: 'AMAZING', keyTerms: 'not-an-array' }],
      queries: ['ok query', 'ab', 42],
    }))!;
    // Heading-derived suffix keeps two stages' id-less outputs from colliding.
    expect(r.outline.sections[0].id).toBe('s1-onlyhe');
    expect(r.outline.sections[0].status).toBe('thin');
    expect(r.outline.sections[0].keyTerms).toEqual([]);
    expect(r.queries).toEqual(['ok query']);
  });

  it('drops heading-less sections; null when none survive; null on garbage', () => {
    expect(parseReflect(JSON.stringify({ sections: [{ goal: 'no heading' }] }))).toBeNull();
    expect(parseReflect('total garbage, no json')).toBeNull();
    expect(parseReflect('')).toBeNull();
  });

  it('caps sections at 10 and queries at 5', () => {
    const many = { sections: Array.from({ length: 14 }, (_, i) => ({ heading: `H${i}` })), queries: Array.from({ length: 9 }, (_, i) => `long query ${i}`) };
    const r = parseReflect(JSON.stringify(many))!;
    expect(r.outline.sections).toHaveLength(10);
    expect(r.queries).toHaveLength(5);
  });
});

describe('mergeOutlines', () => {
  it('re-appends an evidence-rich section the model dropped', () => {
    const prior: ResearchOutline = { version: 2, sections: [sec('s1', 'Kept'), sec('s9', 'Dropped rich', { evidenceNotes: ['a [x.s1.p1]', 'b [y.s1.p1]'] })] };
    const next: ResearchOutline = { version: 3, sections: [sec('s1', 'Kept')] };
    const merged = mergeOutlines(prior, next);
    expect(merged.sections.map(s => s.id)).toEqual(['s1', 's9']);
  });

  it('does NOT resurrect thin dropped sections or fuzzy-duplicate headings', () => {
    const prior: ResearchOutline = { version: 1, sections: [
      sec('s2', 'Thin dropped', { evidenceNotes: ['only one [a.s1.p1]'] }),
      sec('s3', 'Same Heading!', { evidenceNotes: ['a [x.s1.p1]', 'b [y.s1.p1]'] }),
    ] };
    const next: ResearchOutline = { version: 2, sections: [sec('sN', 'same heading')] };
    const merged = mergeOutlines(prior, next);
    expect(merged.sections).toHaveLength(1);
  });

  it('null prior passes through', () => {
    const next: ResearchOutline = { version: 1, sections: [sec('s1', 'A')] };
    expect(mergeOutlines(null, next)).toBe(next);
  });
});

describe('trimOutline', () => {
  it('shaves oldest notes until under budget, never mutating the input', () => {
    const notes = Array.from({ length: 10 }, (_, i) => `note ${i} ${'x'.repeat(200)}`);
    const o: ResearchOutline = { version: 1, sections: [sec('s1', 'A', { evidenceNotes: [...notes] })] };
    const trimmed = trimOutline(o, 1200);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(1200);
    expect(o.sections[0].evidenceNotes).toHaveLength(10); // input untouched
    // Oldest (front) shaved first — the survivor should be a later note.
    expect(trimmed.sections[0].evidenceNotes[0]).not.toBe(notes[0]);
  });
});

describe('formatters', () => {
  it('formatHandoff emits the exact four-heading contract', () => {
    const md = formatHandoff({ establishedFacts: ['f'], openGaps: [], contradictions: [], focusNext: 'go' });
    expect(md).toContain('## Established Facts');
    expect(md).toContain('## Open Gaps');
    expect(md).toContain('## Contradictions Found');
    expect(md).toContain('## Recommended Focus for Next Stage');
    expect(md).toContain('- None');       // empty contradictions default
  });

  it('formatOutlineSkeleton marks thin/empty sections', () => {
    const o: ResearchOutline = { version: 1, sections: [sec('s1', 'Full', { status: 'rich' }), sec('s2', 'Empty', { status: 'empty' })] };
    const sk = formatOutlineSkeleton(o);
    expect(sk).toContain('1. Full');
    expect(sk).toContain('2. Empty (no evidence yet)');
  });
});

describe('selectBriefExcerpts', () => {
  const briefs = [
    'Streaming latency dominates perceived responsiveness in chat interfaces. '.repeat(3) + '\n\n' + 'Unrelated paragraph about gardening and soil quality entirely. '.repeat(3),
    'Optimistic rollback penalties damage trust when predictions fail. '.repeat(3),
  ];
  it('picks only overlapping paragraphs, tagged with stage provenance', () => {
    const out = selectBriefExcerpts(briefs, sec('s1', 'Streaming latency and responsiveness', { keyTerms: ['streaming', 'latency'] }));
    expect(out).toContain('(from Stage 1 brief)');
    expect(out).toContain('Streaming latency');
    expect(out).not.toContain('gardening');
  });
  it('honors the char budget', () => {
    const out = selectBriefExcerpts(briefs, sec('s1', 'Streaming latency responsiveness', { keyTerms: ['streaming'] }), 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

describe('sectionQueriesFallback', () => {
  it('targets only empty/thin sections', () => {
    const o: ResearchOutline = { version: 1, sections: [
      sec('s1', 'Rich one', { status: 'rich' }), sec('s2', 'Thin one'), sec('s3', 'Empty one', { status: 'empty' }),
    ] };
    const qs = sectionQueriesFallback('my topic', o);
    expect(qs).toEqual(['my topic Thin one', 'my topic Empty one']);
  });
});
