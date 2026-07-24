import { describe, it, expect } from 'vitest';
import { parseResearchActivity, phaseProgress, PHASE_ORDER } from '../research-activity';

describe('parseResearchActivity', () => {
  it('starts in planning and stays there through planning lines', () => {
    const a = parseResearchActivity([
      '[PLANNING] Decomposing "battery tech" into research sub-questions…',
      '[PLANNING] 3 sub-questions: a | b | c',
    ]);
    expect(a.phase).toBe('planning');
    expect(a.finished).toBe(false);
    expect(a.captured).toBe(0);
  });

  it('advances to gathering and tracks the read batch', () => {
    const a = parseResearchActivity([
      '[PLANNING] Decomposing…',
      '[WEB] Searching: "solid state battery"',
      '[WEB] Reading 3/8: https://example.com/a',
    ]);
    expect(a.phase).toBe('gathering');
    expect(a.reading).toEqual({ done: 3, total: 8 });
    expect(a.latestLabel).toBe('WEB');
  });

  it('tallies captures and failures across the whole log', () => {
    const a = parseResearchActivity([
      '[WEB] ✓ Captured "A"',
      '[WEB] ✗ Failed: https://x',
      '[ACADEMIC] ✓ Full text captured: "B"',
      '[WEB] ✓ Captured "C"',
    ]);
    expect(a.captured).toBe(3);
    expect(a.failed).toBe(1);
  });

  it('clears the read batch once analysis begins', () => {
    const a = parseResearchActivity([
      '[WEB] Reading 5/8: https://x',
      '[SYNTHESIZING] Writing the report…',
    ]);
    expect(a.phase).toBe('analyzing');
    expect(a.reading).toBeNull();
  });

  it('moves through analyzing into reviewing', () => {
    const a = parseResearchActivity([
      '[SYNTHESIZING] Drafting…',
      '[EVALUATING] Running quality evaluation on report…',
    ]);
    expect(a.phase).toBe('reviewing');
  });

  it('marks finished on DONE', () => {
    const a = parseResearchActivity(['[SYNTHESIZING] …', '[DONE] Research complete.']);
    expect(a.phase).toBe('done');
    expect(a.finished).toBe(true);
  });

  it('marks finished, and phase error, on ERROR', () => {
    const a = parseResearchActivity(['[WEB] Searching…', '[ERROR] Extracted pages had no readable content']);
    expect(a.phase).toBe('error');
    expect(a.finished).toBe(true);
  });

  it('treats INDEX and QUEUE as housekeeping — phase does not regress', () => {
    // A background index upgrade mid-gather must not throw the view back to
    // "planning" or invent a phase of its own.
    const a = parseResearchActivity([
      '[WEB] Reading 2/6: https://x',
      '[INDEX] Upgrading the search index…',
      '[QUEUE] Starting next queued research…',
    ]);
    expect(a.phase).toBe('gathering');
  });

  it('keeps a trailing unlabelled line as the latest text', () => {
    const a = parseResearchActivity(['[WEB] Searching…', 'Interpreted request as: "X"']);
    expect(a.latest).toBe('Interpreted request as: "X"');
  });

  it('is empty-safe', () => {
    const a = parseResearchActivity([]);
    expect(a).toMatchObject({ phase: 'planning', captured: 0, failed: 0, reading: null, finished: false });
  });

  it('strips the label prefix from the displayed latest line', () => {
    const a = parseResearchActivity(['[ACADEMIC] Searching Semantic Scholar']);
    expect(a.latest).toBe('Searching Semantic Scholar');
    expect(a.latest.startsWith('[')).toBe(false);
  });
});

describe('phaseProgress', () => {
  it('increases monotonically through the pipeline', () => {
    let prev = -1;
    for (const p of PHASE_ORDER) {
      const v = phaseProgress(p);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('is 1 at done and bounded in [0,1] everywhere', () => {
    expect(phaseProgress('done')).toBe(1);
    for (const p of [...PHASE_ORDER, 'done', 'error'] as const) {
      const v = phaseProgress(p);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
