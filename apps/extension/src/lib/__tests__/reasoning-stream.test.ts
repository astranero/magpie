import { describe, it, expect } from 'vitest';
import { createThinkSplitter, reasoningFromDelta, reasoningTail } from '../reasoning-stream';

/** Feed deltas in order, return the concatenated split (including the flush). */
function run(deltas: string[]) {
  const s = createThinkSplitter();
  let answer = '', reasoning = '';
  for (const d of deltas) {
    const r = s.push(d);
    answer += r.answer;
    reasoning += r.reasoning;
  }
  const f = s.flush();
  return { answer: answer + f.answer, reasoning: reasoning + f.reasoning };
}

describe('createThinkSplitter', () => {
  it('separates a complete think block delivered in one chunk', () => {
    const r = run(['<think>weighing the options</think>The answer is 42.']);
    expect(r.reasoning).toBe('weighing the options');
    expect(r.answer).toBe('The answer is 42.');
  });

  it('handles a tag split across chunk boundaries — the whole point', () => {
    // `<think>` arrives as four fragments; a per-chunk replace would leak them.
    const r = run(['<th', 'in', 'k>', 'hmm', '</thi', 'nk>', 'Done.']);
    expect(r.reasoning).toBe('hmm');
    expect(r.answer).toBe('Done.');
  });

  it('streams reasoning as it arrives rather than holding it to the closer', () => {
    // A long thinking block must not buffer silently — that is the dead air bug.
    const s = createThinkSplitter();
    s.push('<think>first thought. ');
    const mid = s.push('second thought. ');
    expect(mid.reasoning).toBe('second thought. ');
    expect(mid.answer).toBe('');
  });

  it('passes plain content through untouched when there is no tag', () => {
    const r = run(['Just ', 'a normal ', 'answer.']);
    expect(r.answer).toBe('Just a normal answer.');
    expect(r.reasoning).toBe('');
  });

  it('does not eat a trailing "<" that never becomes a tag', () => {
    // Held back mid-stream on the chance it was `<think>`; flush must release it.
    const r = run(['5 ', '< ', '8']);
    expect(r.answer).toBe('5 < 8');
  });

  it('releases an unterminated think block as reasoning, never as answer', () => {
    // Model cut off mid-thought: the private trace must not become the reply.
    const r = run(['<think>half a thou']);
    expect(r.reasoning).toBe('half a thou');
    expect(r.answer).toBe('');
  });

  it('keeps text before an opening tag in the answer', () => {
    const r = run(['Preamble. <think>aside</think> Rest.']);
    expect(r.answer).toBe('Preamble.  Rest.');
    expect(r.reasoning).toBe('aside');
  });

  it('supports <thinking> as well as <think>', () => {
    const r = run(['<thinking>alt tag</thinking>ok']);
    expect(r.reasoning).toBe('alt tag');
    expect(r.answer).toBe('ok');
  });

  it('handles several think blocks in one response', () => {
    const r = run(['<think>a</think>one <think>b</think>two']);
    expect(r.reasoning).toBe('ab');
    expect(r.answer).toBe('one two');
  });

  it('reports whether it is mid-thought', () => {
    const s = createThinkSplitter();
    expect(s.isInsideThink).toBe(false);
    s.push('<think>x');
    expect(s.isInsideThink).toBe(true);
    s.push('</think>');
    expect(s.isInsideThink).toBe(false);
  });

  it('flush is idempotent', () => {
    const s = createThinkSplitter();
    s.push('tail<');
    expect(s.flush().answer).toBe('<');
    expect(s.flush().answer).toBe('');
  });
});

describe('reasoningFromDelta', () => {
  it('reads DeepSeek reasoning_content and OpenRouter reasoning', () => {
    expect(reasoningFromDelta({ reasoning_content: 'dsr' })).toBe('dsr');
    expect(reasoningFromDelta({ reasoning: 'orr' })).toBe('orr');
  });

  it('returns empty for an ordinary content-only delta', () => {
    // Non-reasoning models must behave exactly as before.
    expect(reasoningFromDelta({ content: 'hello' })).toBe('');
    expect(reasoningFromDelta(null)).toBe('');
    expect(reasoningFromDelta('nope')).toBe('');
    expect(reasoningFromDelta({ reasoning: 42 })).toBe('');
  });
});

describe('reasoningTail', () => {
  it('takes the last non-empty line', () => {
    expect(reasoningTail('first\n\nsecond\n')).toBe('second');
  });

  it('clips a long line from the left, keeping the newest text', () => {
    const out = reasoningTail('x'.repeat(300), 40);
    expect(out.length).toBe(40);
    expect(out.startsWith('…')).toBe(true);
  });

  it('handles empty input', () => {
    expect(reasoningTail('')).toBe('');
  });
});
