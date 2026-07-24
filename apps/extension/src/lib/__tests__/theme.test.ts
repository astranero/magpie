import { describe, it, expect } from 'vitest';
import { readThemePref, resolveTheme, THEMES, THEME_LABELS } from '../theme';

describe('readThemePref', () => {
  it('accepts every declared theme', () => {
    for (const t of THEMES) expect(readThemePref(t)).toBe(t);
  });

  it('falls back to system for absent or unknown values', () => {
    // A stale key from an older build must not wedge the panel in no-theme land.
    expect(readThemePref(null)).toBe('system');
    expect(readThemePref(undefined)).toBe('system');
    expect(readThemePref('')).toBe('system');
    expect(readThemePref('sepia')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('follows the OS only for system', () => {
    expect(resolveTheme('system', true)).toEqual({ dark: true, village: false });
    expect(resolveTheme('system', false)).toEqual({ dark: false, village: false });
  });

  it('honours an explicit light/dark choice over the OS', () => {
    expect(resolveTheme('dark', false)).toEqual({ dark: true, village: false });
    expect(resolveTheme('light', true)).toEqual({ dark: false, village: false });
  });

  it('treats village as a LIGHT theme — never both classes at once', () => {
    // .village and .dark are both single-class selectors keyed on the same
    // tokens; if both landed on <html> the winner would be CSS source order,
    // not the user's choice.
    expect(resolveTheme('village', true)).toEqual({ dark: false, village: true });
    expect(resolveTheme('village', false)).toEqual({ dark: false, village: true });
  });

  it('never returns both flags for any input', () => {
    for (const t of THEMES) {
      for (const osDark of [true, false]) {
        const r = resolveTheme(t, osDark);
        expect(r.dark && r.village).toBe(false);
      }
    }
  });
});

describe('THEME_LABELS', () => {
  it('covers every theme, so the picker can never render a blank row', () => {
    for (const t of THEMES) {
      expect(THEME_LABELS[t].label).toBeTruthy();
      expect(THEME_LABELS[t].hint).toBeTruthy();
    }
  });
});
