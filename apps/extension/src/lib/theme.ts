// ─────────────────────────────────────────────
// Theme preference → the classes on <html>
// ─────────────────────────────────────────────
// Four palettes live in index.css: the default plumage light theme (:root),
// `.dark`, `.village`, and `.ghibli`. The preference is NOT a light/dark axis —
// village and ghibli are themselves light themes, so they and dark are mutually
// exclusive. Keeping that rule here (rather than inline in main.tsx) makes it
// testable and stops the settings picker and the applier from disagreeing about
// what's valid.

export const THEME_STORAGE_KEY = 'magpie-theme';
export const THEME_CHANGED_EVENT = 'magpie-theme-changed';

export const THEMES = ['system', 'light', 'dark', 'village', 'ghibli'] as const;
export type ThemePref = (typeof THEMES)[number];

export const THEME_LABELS: Record<ThemePref, { label: string; hint: string }> = {
  system:  { label: 'System',  hint: 'Follow the OS setting' },
  light:   { label: 'Light',   hint: 'Feather white' },
  dark:    { label: 'Dark',    hint: 'Plumage at night' },
  village: { label: 'Village', hint: 'Warm plaster & moss' },
  ghibli:  { label: 'Ghibli',  hint: 'Big sky & meadow' },
};

/** The palettes that are a named illustration rather than a light/dark setting. */
export const SCENE_THEMES = ['village', 'ghibli'] as const;
export type SceneTheme = (typeof SCENE_THEMES)[number];

/** Unknown/absent values fall back to `system` — a stale key can't wedge the UI. */
export function readThemePref(raw: string | null | undefined): ThemePref {
  return (THEMES as readonly string[]).includes(raw ?? '') ? (raw as ThemePref) : 'system';
}

/**
 * Which classes <html> should carry. At most one is ever true.
 *
 * `.dark`, `.village` and `.ghibli` are all single-class selectors setting the
 * same custom properties, so two of them at once would be decided by source
 * order rather than by intent.
 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): {
  dark: boolean; village: boolean; ghibli: boolean;
} {
  if (pref === 'village') return { dark: false, village: true, ghibli: false };
  if (pref === 'ghibli') return { dark: false, village: false, ghibli: true };
  return { dark: pref === 'dark' || (pref === 'system' && prefersDark), village: false, ghibli: false };
}

/** The active scene palette, or null for the plain light/dark themes. */
export function sceneOf(pref: ThemePref): SceneTheme | null {
  return (SCENE_THEMES as readonly string[]).includes(pref) ? (pref as SceneTheme) : null;
}

/**
 * The scene currently on <html>, read from the DOM rather than from storage.
 *
 * The class is the single source of truth — main.tsx already resolves the
 * preference (including `system`, which storage does not answer) and writes it
 * there. Re-deriving it from the raw pref here would give two answers to the
 * same question and let them drift.
 */
export function activeScene(el?: { classList: { contains(c: string): boolean } }): SceneTheme | null {
  const root = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root) return null;
  for (const s of SCENE_THEMES) if (root.classList.contains(s)) return s;
  return null;
}
