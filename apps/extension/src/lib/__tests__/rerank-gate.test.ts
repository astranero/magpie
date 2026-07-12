import { describe, it, expect } from 'vitest';
import { gateRerankedChunks, isConfidentMatch, RERANK_MIN_SCORE, RERANK_JUNK_SCORE } from '../vector-store';

const mk = (id: string, score: number) => ({ chunk: id, score });

describe('gateRerankedChunks', () => {
  it('keeps only chunks above the relevance gate, best first', () => {
    const out = gateRerankedChunks([mk('junk', -9), mk('good', 2), mk('borderline', -5), mk('ok', 0)], 10);
    expect(out).toEqual(['good', 'ok']);
  });

  it('never pads irrelevant chunks up to the limit', () => {
    const out = gateRerankedChunks([mk('a', 1), mk('junk1', -7), mk('junk2', -6)], 3);
    expect(out).toEqual(['a']);
  });

  it('all-below-gate: returns at most 2 borderline, none if hopeless', () => {
    expect(gateRerankedChunks([mk('b1', -5), mk('b2', -6), mk('b3', -7)], 10)).toEqual(['b1', 'b2']);
    expect(gateRerankedChunks([mk('x', -9), mk('y', -12)], 10)).toEqual([]);
  });

  it('respects limit on relevant chunks', () => {
    const scored = Array.from({ length: 10 }, (_, i) => mk(`c${i}`, 10 - i));
    expect(gateRerankedChunks(scored, 3)).toEqual(['c0', 'c1', 'c2']);
  });

  it('applies the relative score cliff when the top hit is confident', () => {
    // top = 5; -3 clears the absolute gate (-4) but sits >7 below the top →
    // keyword-coincidence noise, dropped.
    const out = gateRerankedChunks([mk('top', 5), mk('close', 1), mk('far', -3)], 10);
    expect(out).toEqual(['top', 'close']);
  });

  it('no cliff when the top hit itself is weak', () => {
    // top ≤ 0: everything above the absolute gate is kept — a weak-but-broad
    // result set shouldn't collapse to one chunk.
    const out = gateRerankedChunks([mk('a', -1), mk('b', -3.5)], 10);
    expect(out).toEqual(['a', 'b']);
  });

    it('gate constants keep their intended ordering', () => {
    expect(RERANK_MIN_SCORE).toBeGreaterThan(RERANK_JUNK_SCORE);
    expect(RERANK_MIN_SCORE).toBeLessThan(0);
  });
});

describe('isConfidentMatch (chat: ground on workspace vs go to web)', () => {
  it('empty retrieval is not confident', () => {
    expect(isConfidentMatch([])).toBe(false);
  });

  it('genuinely relevant top chunk (> 0) is confident', () => {
    expect(isConfidentMatch([{ rerankScore: 3.2 }, { rerankScore: -1 }])).toBe(true);
  });

  it('only borderline chunks (all ≤ 0) are NOT confident — the weather-tomorrow case', () => {
    // These clear the display gate (-4) so they render, but "weather tomorrow"
    // is not genuinely answered by the workspace → should escalate to the web.
    expect(isConfidentMatch([{ rerankScore: -1.5 }, { rerankScore: -3 }])).toBe(false);
  });

  it('does not second-guess when the reranker was unavailable (no scores)', () => {
    expect(isConfidentMatch([{}, {}])).toBe(true);
  });
});
