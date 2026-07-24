import { describe, it, expect } from 'vitest';
import { readThemePref, resolveTheme, sceneOf, THEMES, THEME_LABELS, SCENE_THEMES } from '../theme';

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
    expect(resolveTheme('system', true)).toEqual({ dark: true, village: false, ghibli: false });
    expect(resolveTheme('system', false)).toEqual({ dark: false, village: false, ghibli: false });
  });

  it('honours an explicit light/dark choice over the OS', () => {
    expect(resolveTheme('dark', false)).toEqual({ dark: true, village: false, ghibli: false });
    expect(resolveTheme('light', true)).toEqual({ dark: false, village: false, ghibli: false });
  });

  it('treats the scene palettes as LIGHT themes — never two classes at once', () => {
    // .village, .ghibli and .dark are all single-class selectors keyed on the
    // same tokens; if two landed on <html> the winner would be CSS source
    // order, not the user's choice.
    expect(resolveTheme('village', true)).toEqual({ dark: false, village: true, ghibli: false });
    expect(resolveTheme('village', false)).toEqual({ dark: false, village: true, ghibli: false });
    expect(resolveTheme('ghibli', true)).toEqual({ dark: false, village: false, ghibli: true });
    expect(resolveTheme('ghibli', false)).toEqual({ dark: false, village: false, ghibli: true });
  });

  it('never returns more than one flag, for any theme and any OS setting', () => {
    for (const t of THEMES) {
      for (const osDark of [true, false]) {
        const r = resolveTheme(t, osDark);
        expect([r.dark, r.village, r.ghibli].filter(Boolean).length).toBeLessThanOrEqual(1);
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

describe('sceneOf', () => {
  it('names the illustrated palettes and nothing else', () => {
    expect(sceneOf('village')).toBe('village');
    expect(sceneOf('ghibli')).toBe('ghibli');
    for (const t of ['system', 'light', 'dark'] as const) expect(sceneOf(t)).toBeNull();
  });

  it('agrees with resolveTheme about which palettes are scenes', () => {
    // A scene must be exactly a theme that sets its own class. If these ever
    // disagree, the flying-magpie decoration renders over a palette that has
    // no artwork behind it.
    for (const t of THEMES) {
      const r = resolveTheme(t, false);
      expect(sceneOf(t) !== null).toBe(r.village || r.ghibli);
    }
  });

  it('every scene has a label, so the picker cannot render a blank row', () => {
    for (const s of SCENE_THEMES) expect(THEME_LABELS[s].label).toBeTruthy();
  });
});
