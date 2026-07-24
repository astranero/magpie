import { describe, it, expect } from 'vitest';
import { BUILTIN_GEMINI_SENTINEL } from '../provider-detect';

describe('provider-detect (gutted)', () => {
  it('exports a dead sentinel value for backwards compat', () => {
    expect(BUILTIN_GEMINI_SENTINEL).toBe('__removed__');
  });
});
