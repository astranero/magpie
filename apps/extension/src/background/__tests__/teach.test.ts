import { describe, it, expect } from 'vitest';
import {
  parseMissionBlock, upsertMissionBlock, priorLessons, nextLessonNumber,
  parseLessonResponse, MISSION_OPEN, MISSION_CLOSE,
} from '../teach';
import { buildFrontmatter } from '../../lib/frontmatter';

// The mission lives in project.rules alongside whatever the user wrote there.
// Losing their rules to a course they started would be a genuinely bad surprise,
// so the round-trip is pinned here.
describe('mission block', () => {
  it('returns null when no course has been started', () => {
    expect(parseMissionBlock(undefined)).toBeNull();
    expect(parseMissionBlock('Always answer in Finnish.')).toBeNull();
  });

  it('round-trips a mission through the rules field', () => {
    const rules = upsertMissionBlock('', 'Ship a Rust CLI at work.');
    expect(parseMissionBlock(rules)).toBe('Ship a Rust CLI at work.');
  });

  it("preserves the user's own rules when adding a mission", () => {
    const rules = upsertMissionBlock('Always answer in Finnish.', 'Learn Rust.');
    expect(rules).toContain('Always answer in Finnish.');
    expect(parseMissionBlock(rules)).toBe('Learn Rust.');
  });

  it('replaces an existing mission without duplicating the block or dropping rules', () => {
    const first = upsertMissionBlock('Be terse.', 'Learn Rust.');
    const second = upsertMissionBlock(first, 'Learn Go instead.');
    expect(parseMissionBlock(second)).toBe('Learn Go instead.');
    expect(second).toContain('Be terse.');
    expect(second.split(MISSION_OPEN).length - 1).toBe(1);
    expect(second.split(MISSION_CLOSE).length - 1).toBe(1);
  });

  it('treats an empty block as no mission', () => {
    expect(parseMissionBlock(`${MISSION_OPEN}\n\n${MISSION_CLOSE}`)).toBeNull();
  });
});

// Lesson sequencing reads back the frontmatter written by a previous run, so
// these two must stay in agreement — hence building the fixtures with the real
// frontmatter builder rather than hand-written YAML.
function lessonDoc(n: number, title: string, covers: string) {
  return {
    title: `Lesson ${n}: ${title}`,
    content: buildFrontmatter({
      title: `Lesson ${n}: ${title}`,
      type: 'lesson',
      wordCount: 400,
      extra: { lesson: n, covers },
    }) + 'body text',
  };
}

describe('lesson sequencing', () => {
  it('reads lessons written by the frontmatter builder', () => {
    const prior = priorLessons([lessonDoc(1, 'Ownership', 'move semantics, borrow')]);
    expect(prior).toEqual([{ number: 1, title: 'Ownership', covers: 'move semantics, borrow' }]);
  });

  it('ignores non-lesson documents in the workspace', () => {
    const docs = [
      lessonDoc(1, 'Ownership', 'move semantics'),
      { title: 'Some article', content: buildFrontmatter({ title: 'Some article', type: 'web-capture' }) + 'x' },
    ];
    expect(priorLessons(docs)).toHaveLength(1);
  });

  it('orders by lesson number, not insertion order', () => {
    const nums = priorLessons([lessonDoc(3, 'C', ''), lessonDoc(1, 'A', ''), lessonDoc(2, 'B', '')])
      .map(l => l.number);
    expect(nums).toEqual([1, 2, 3]);
  });

  it('numbers the first lesson 1 and continues from the highest', () => {
    expect(nextLessonNumber([])).toBe(1);
    expect(nextLessonNumber(priorLessons([lessonDoc(1, 'A', ''), lessonDoc(2, 'B', '')]))).toBe(3);
  });

  it('does not reuse a number after an earlier lesson is deleted', () => {
    // Deleting lesson 2 must not make the next lesson collide with lesson 3.
    expect(nextLessonNumber(priorLessons([lessonDoc(1, 'A', ''), lessonDoc(3, 'C', '')]))).toBe(4);
  });
});

describe('parseLessonResponse', () => {
  const good = `TITLE: Borrowing basics
COVERS: shared refs, mutable refs
LESSON:
## What you'll be able to do
Pass data to a function without giving it away.

${'Explanatory prose. '.repeat(20)}`;

  it('extracts title, covers, and body', () => {
    const r = parseLessonResponse(good)!;
    expect(r.title).toBe('Borrowing basics');
    expect(r.covers).toBe('shared refs, mutable refs');
    expect(r.body).toContain("What you'll be able to do");
    expect(r.body).not.toContain('TITLE:');
  });

  it('tolerates a missing COVERS line', () => {
    const r = parseLessonResponse(good.replace(/^COVERS:.*$/m, ''))!;
    expect(r).not.toBeNull();
    expect(r.covers).toBe('');
  });

  it('rejects a reply with no lesson body marker', () => {
    expect(parseLessonResponse('TITLE: x\nJust some prose, no marker.')).toBeNull();
  });

  it('rejects a body too short to have taught anything', () => {
    expect(parseLessonResponse('TITLE: x\nCOVERS: y\nLESSON:\ntoo short')).toBeNull();
  });
});

import { parseSyllabus, nextStep, parseQuizBlock, parseGrade, isVagueTopic, parseFlashcards } from '../teach';

describe('parseSyllabus', () => {
  const block = (steps: any) => `Here is your course:\n\`\`\`json\n${JSON.stringify(steps)}\n\`\`\``;

  it('parses an ordered array of steps and renumbers densely', () => {
    const steps = parseSyllabus(block([
      { title: 'Foundations', covers: 'a, b', goal: 'define X' },
      { title: 'Applying it', covers: 'c', goal: 'use X' },
      { title: 'Edge cases', covers: 'd', goal: 'handle Y' },
    ]));
    expect(steps.map(s => s.n)).toEqual([1, 2, 3]);
    expect(steps[0].title).toBe('Foundations');
    expect(steps[1].goal).toBe('use X');
  });

  it('accepts a {steps:[…]} wrapper', () => {
    expect(parseSyllabus(block({ steps: [{ title: 'A' }, { title: 'B' }] })).length).toBe(2);
  });

  it('returns [] for a missing or malformed block', () => {
    expect(parseSyllabus('no json here')).toEqual([]);
    expect(parseSyllabus('```json\nnot json\n```')).toEqual([]);
    expect(parseSyllabus(block([{ title: 'only one' }]))).toEqual([]); // needs >=2
  });
});

describe('nextStep', () => {
  const steps = parseSyllabus('```json\n' + JSON.stringify([{ title: 'A' }, { title: 'B' }, { title: 'C' }]) + '\n```');
  it('returns step matching the next lesson number', () => {
    expect(nextStep([], steps)?.title).toBe('A');
    expect(nextStep([{ number: 1, title: 'A', covers: '' }], steps)?.title).toBe('B');
  });
  it('returns null once the course is done', () => {
    const prior = [1, 2, 3].map(n => ({ number: n, title: '', covers: '' }));
    expect(nextStep(prior, steps)).toBe(null);
  });
});

describe('parseQuizBlock', () => {
  const wrap = (qs: any) => `Lesson text.\n\`\`\`json\n${JSON.stringify(qs)}\n\`\`\``;

  it('parses mixed mcq + open questions', () => {
    const qs = parseQuizBlock(wrap([
      { type: 'mcq', prompt: 'Pick', options: ['a', 'b', 'c'], answerIndex: 1, explanation: 'because' },
      { type: 'open', prompt: 'Explain', modelAnswer: 'the answer' },
    ]));
    expect(qs.length).toBe(2);
    expect(qs[0]).toMatchObject({ type: 'mcq', answerIndex: 1 });
    expect(qs[1]).toMatchObject({ type: 'open', modelAnswer: 'the answer' });
  });

  it('drops an mcq without >=2 options or a valid answerIndex', () => {
    expect(parseQuizBlock(wrap([{ type: 'mcq', prompt: 'x', options: ['only'], answerIndex: 0 }]))).toEqual([]);
    expect(parseQuizBlock(wrap([{ type: 'mcq', prompt: 'x', options: ['a', 'b'], answerIndex: 9 }]))).toEqual([]);
  });

  it('drops an open question with no model answer, and accepts {answer} as an alias', () => {
    expect(parseQuizBlock(wrap([{ type: 'open', prompt: 'x' }]))).toEqual([]);
    expect(parseQuizBlock(wrap([{ type: 'open', prompt: 'x', answer: 'y' }]))[0].modelAnswer).toBe('y');
  });

  it('fails soft to [] on a missing or malformed block', () => {
    expect(parseQuizBlock('no quiz')).toEqual([]);
    expect(parseQuizBlock('```json\n{bad\n```')).toEqual([]);
  });
});

describe('parseGrade', () => {
  it('reads the verdict and strips the verdict line from feedback', () => {
    const g = parseGrade('VERDICT: correct\nNice — you nailed the key idea.');
    expect(g.verdict).toBe('correct');
    expect(g.feedback).toBe('Nice — you nailed the key idea.');
  });
  it('defaults to partial when no verdict is found', () => {
    expect(parseGrade('some rambling with no verdict').verdict).toBe('partial');
  });
});

describe('isVagueTopic', () => {
  it('treats vague references as unspecified', () => {
    for (const t of ['', '   ', 'this', 'this topic', 'about this topic', 'that research', 'it', 'the report', 'these']) {
      expect(isVagueTopic(t)).toBe(true);
    }
  });
  it('keeps a real topic', () => {
    for (const t of ['spaced repetition', 'best practices for teaching', 'how transformers work']) {
      expect(isVagueTopic(t)).toBe(false);
    }
  });
});

describe('parseFlashcards', () => {
  const wrap = (cs: any) => `Deck:\n\`\`\`json\n${JSON.stringify(cs)}\n\`\`\``;
  it('parses front/back cards with optional hint', () => {
    const cards = parseFlashcards(wrap([
      { front: 'What is X?', back: 'X is a thing', hint: 'starts with t' },
      { front: 'Why Y?', back: 'because Z' },
    ]));
    expect(cards.length).toBe(2);
    expect(cards[0]).toMatchObject({ front: 'What is X?', back: 'X is a thing', hint: 'starts with t' });
    expect(cards[1].hint).toBeUndefined();
  });
  it('drops cards missing a front or back', () => {
    expect(parseFlashcards(wrap([{ front: 'only front' }, { back: 'only back' }]))).toEqual([]);
  });
  it('accepts a {cards:[…]} wrapper and fails soft otherwise', () => {
    expect(parseFlashcards(wrap({ cards: [{ front: 'a', back: 'b' }, { front: 'c', back: 'd' }] })).length).toBe(2);
    expect(parseFlashcards('no json')).toEqual([]);
  });
});
