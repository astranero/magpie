import { describe, it, expect } from 'vitest';
import { parseFollowUps, shouldSuggestFollowUps } from '../follow-ups';

describe('shouldSuggestFollowUps', () => {
  it('fires on branches that answered a real question', () => {
    for (const b of ['citation', 'page', 'web', 'general']) {
      expect(shouldSuggestFollowUps(b, false)).toBe(true);
    }
  });

  it('skips greetings, self-questions and the no-page case', () => {
    // There is no sensible next question after "hi" or "what are you".
    for (const b of ['chitchat', 'meta', 'no-page']) {
      expect(shouldSuggestFollowUps(b, false)).toBe(false);
    }
  });

  it('skips slash-command turns', () => {
    // A command's follow-up is running it again with different input, not a
    // question — and the user is charged for this call either way.
    expect(shouldSuggestFollowUps('citation', true)).toBe(false);
  });
});

describe('parseFollowUps', () => {
  it('reads the clean one-per-line form', () => {
    expect(parseFollowUps('What is the pool size?\nHow is it configured?')).toEqual([
      'What is the pool size?', 'How is it configured?',
    ]);
  });

  it('strips numbering, bullets and quotes', () => {
    const raw = '1. What is the pool size?\n- How is it configured?\n* "Why 20 connections?"';
    expect(parseFollowUps(raw)).toEqual([
      'What is the pool size?', 'How is it configured?', 'Why 20 connections?',
    ]);
  });

  it('survives a code fence, which models add unprompted', () => {
    expect(parseFollowUps('```\nWhat is the pool size?\n```')).toEqual(['What is the pool size?']);
  });

  it('drops a preamble line — it is not a question', () => {
    const raw = 'Here are three follow-up questions:\nWhat is the pool size?';
    expect(parseFollowUps(raw)).toEqual(['What is the pool size?']);
  });

  it('cuts an explanation appended after the question mark', () => {
    const raw = 'What is the pool size? This would clarify the configuration.';
    expect(parseFollowUps(raw)).toEqual(['What is the pool size?']);
  });

  it('caps at three', () => {
    const raw = ['First question?', 'Second question?', 'Third question?', 'Fourth question?'].join('\n');
    expect(parseFollowUps(raw)).toHaveLength(3);
  });

  it('deduplicates case-insensitively', () => {
    expect(parseFollowUps('What is it?\nwhat is it?')).toHaveLength(1);
  });

  it('rejects fragments and over-long lines rather than showing a broken chip', () => {
    expect(parseFollowUps('Why?')).toEqual([]);                       // too short
    expect(parseFollowUps('W'.repeat(120) + '?')).toEqual([]);         // too long
  });

  it('returns empty for output with no questions at all', () => {
    expect(parseFollowUps('I cannot suggest any follow-ups.')).toEqual([]);
    expect(parseFollowUps('')).toEqual([]);
  });

  it('keeps non-Latin questions intact', () => {
    // The prompt asks for the user's language; the parser must not mangle it.
    expect(parseFollowUps('Mikä on altaan koko?')).toEqual(['Mikä on altaan koko?']);
  });
});
