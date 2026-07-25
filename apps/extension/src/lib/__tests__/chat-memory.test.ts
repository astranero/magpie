import { describe, it, expect } from 'vitest';
import {
  selectHistory, overlapScore, buildLedger,
  RECENT_MESSAGES, MAX_RECALLED, HISTORY_CHAR_BUDGET,
} from '../chat-memory';

// Replaces a hard slice(-16): at turn 17, turn 1 vanished with no indication, so
// a question reaching back got a confident answer from a model that had never
// heard the earlier turn.

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });

/** n exchanges of filler that share no vocabulary with the probe queries. */
function filler(n: number) {
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < n; i++) {
    out.push(u(`Unrelated question number ${i} concerning weather patterns`));
    out.push(a(`Unrelated answer number ${i} concerning weather patterns`));
  }
  return out;
}

describe('selectHistory — the no-change case', () => {
  it('returns everything untouched for a short conversation', () => {
    const all = [u('hello'), a('hi')];
    const r = selectHistory(all, 'anything');
    expect(r.turns).toEqual(all);
    expect(r.elided).toBe(0);
    expect(r.recalled).toBe(0);
  });

  it('behaves exactly like the old tail-slice when nothing older is relevant', () => {
    // The property that keeps short chats unaffected: with no older exchange
    // above the floor, the output IS the recent window.
    const all = filler(10);
    const r = selectHistory(all, 'quantum cryptography lattice signatures');
    expect(r.recalled).toBe(0);
    expect(r.turns).toEqual(all.slice(-RECENT_MESSAGES));
  });
});

describe('selectHistory — recall', () => {
  it('brings back the older exchange the question refers to', () => {
    const all = [
      u('What did we decide about the Postgres connection pool size?'),
      a('We settled on 20 connections with a 30 second idle timeout.'),
      ...filler(10),
    ];
    const r = selectHistory(all, 'Postgres connection pool size decision');
    expect(r.recalled).toBe(1);
    const text = r.turns.map(t => t.content).join(' ');
    expect(text).toContain('20 connections');
  });

  it('recalls the QUESTION with its answer, never the answer alone', () => {
    // An answer without its question reads as an unprompted assertion, and the
    // model cannot tell what it was responding to.
    const all = [
      u('What is the pool size?'),
      a('Twenty connections.'),
      ...filler(10),
    ];
    const r = selectHistory(all, 'pool size');
    const recalled = r.turns.slice(0, 3).map(t => t.content).join(' ');
    expect(recalled).toContain('What is the pool size?');
    expect(recalled).toContain('Twenty connections.');
  });

  it('marks the gap so the model knows the transcript is not contiguous', () => {
    const all = [u('Pool size question'), a('Pool size answer'), ...filler(10)];
    const r = selectHistory(all, 'pool size');
    expect(r.turns.some(t => t.content.includes('earlier turns omitted'))).toBe(true);
    expect(r.elided).toBeGreaterThan(0);
  });

  it('keeps recalled exchanges in chronological order', () => {
    const all = [
      u('First we discussed caching strategy'), a('Caching answer'),
      u('Then we discussed caching invalidation'), a('Invalidation answer'),
      ...filler(10),
    ];
    const r = selectHistory(all, 'caching strategy invalidation');
    const idxFirst = r.turns.findIndex(t => t.content.includes('First we discussed'));
    const idxSecond = r.turns.findIndex(t => t.content.includes('Then we discussed'));
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it('never recalls more than the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => [
      u(`Discussion of the caching strategy variant ${i}`),
      a(`Answer about caching strategy variant ${i}`),
    ]).flat();
    const r = selectHistory([...many, ...filler(10)], 'caching strategy variant');
    expect(r.recalled).toBeLessThanOrEqual(MAX_RECALLED);
  });

  it('always ends with the recent window intact', () => {
    const all = [u('Pool size question'), a('Pool size answer'), ...filler(10)];
    const r = selectHistory(all, 'pool size');
    expect(r.turns.slice(-RECENT_MESSAGES)).toEqual(all.slice(-RECENT_MESSAGES));
  });
});

describe('selectHistory — bounds', () => {
  it('has a fixed ceiling however long the conversation runs', () => {
    // The whole point of recall over summarisation: context cannot grow.
    const huge = Array.from({ length: 200 }, (_, i) => [
      u(`Caching strategy question ${i} ${'x'.repeat(200)}`),
      a(`Caching strategy answer ${i} ${'x'.repeat(200)}`),
    ]).flat();
    const r = selectHistory(huge, 'caching strategy question');
    const chars = r.turns.reduce((n, t) => n + t.content.length, 0);
    expect(chars).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET * 1.5);
  });

  it('never drops a recent turn to fit a recalled one', () => {
    const all = [
      u(`Caching strategy ${'y'.repeat(HISTORY_CHAR_BUDGET)}`),
      a('answer'),
      ...filler(10),
    ];
    const r = selectHistory(all, 'caching strategy');
    expect(r.turns.slice(-RECENT_MESSAGES)).toEqual(all.slice(-RECENT_MESSAGES));
  });
});

describe('overlapScore', () => {
  it('scores by the fraction of the QUERY covered, not the text length', () => {
    // Asymmetric on purpose: a long exchange should not be penalised for
    // containing more than the question asked about.
    expect(overlapScore('postgres pool', 'postgres pool ' + 'noise '.repeat(100))).toBe(1);
  });

  it('is zero for unrelated text and for an empty query', () => {
    expect(overlapScore('postgres pool', 'weather forecast tomorrow')).toBe(0);
    expect(overlapScore('', 'anything')).toBe(0);
  });
});

describe('buildLedger', () => {
  it('lists earlier topics newest-first, deduplicated', () => {
    const led = buildLedger(['pool size', 'caching', 'pool size']);
    expect(led).toContain('caching');
    expect(led.indexOf('caching')).toBeLessThan(led.indexOf('pool size'));
    expect(led.match(/pool size/g) || []).toHaveLength(1);
  });

  it('omits slash commands — an instruction is not a topic', () => {
    expect(buildLedger(['/clear', '/research widgets'])).toBe('');
  });

  it('stays within its budget and truncates long questions', () => {
    const led = buildLedger(Array.from({ length: 50 }, (_, i) => `topic number ${i} ${'z'.repeat(80)}`));
    expect(led.length).toBeLessThanOrEqual(500);
    expect(led).toContain('…');
  });

  it('returns empty when there is nothing older', () => {
    expect(buildLedger([])).toBe('');
  });
});
