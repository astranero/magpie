import { describe, it, expect } from 'vitest';
import { isImeComposing } from '../ime';

// The bug this prevents: typing Chinese/Japanese/Korean, pressing Enter to
// CONFIRM a candidate, and having the chat send a half-composed message instead.
// Invisible to anyone testing in English — every Latin Enter is a real Enter.

describe('isImeComposing', () => {
  it('detects composition via the React synthetic event', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
  });

  it('detects composition on a plain DOM event', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });

  it('detects the legacy keyCode 229 sentinel', () => {
    // Some browsers/IMEs emit "processing key" instead of setting isComposing.
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
  });

  it('lets a REAL Enter through — the guard must not block ordinary sending', () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false);
    expect(isImeComposing({ keyCode: 13 })).toBe(false);
  });

  it('treats an absent event as not composing', () => {
    expect(isImeComposing(null)).toBe(false);
    expect(isImeComposing(undefined)).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });

  it('ignores a non-boolean isComposing rather than coercing it', () => {
    expect(isImeComposing({ nativeEvent: { isComposing: undefined } })).toBe(false);
  });
});
