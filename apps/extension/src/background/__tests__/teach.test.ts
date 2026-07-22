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
