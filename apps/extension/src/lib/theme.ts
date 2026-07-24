// ─────────────────────────────────────────────
// Theme preference → the classes on <html>
// ─────────────────────────────────────────────
// Three palettes live in index.css: the default plumage light theme (:root),
// `.dark`, and `.village`. The preference is NOT a light/dark axis — village is
// itself a light theme, so it and dark are mutually exclusive. Keeping that
// rule here (rather than inline in main.tsx) makes it testable and stops the
// settings picker and the applier from disagreeing about what's valid.

export const THEME_STORAGE_KEY = 'magpie-theme';
export const THEME_CHANGED_EVENT = 'magpie-theme-changed';

export const THEMES = ['system', 'light', 'dark', 'village'] as const;
export type ThemePref = (typeof THEMES)[number];

export const THEME_LABELS: Record<ThemePref, { label: string; hint: string }> = {
  system:  { label: 'System',  hint: 'Follow the OS setting' },
  light:   { label: 'Light',   hint: 'Feather white' },
  dark:    { label: 'Dark',    hint: 'Plumage at night' },
  village: { label: 'Village', hint: 'Warm plaster & moss' },
};

/** Unknown/absent values fall back to `system` — a stale key can't wedge the UI. */
export function readThemePref(raw: string | null | undefined): ThemePref {
  return (THEMES as readonly string[]).includes(raw ?? '') ? (raw as ThemePref) : 'system';
}

/** Which classes <html> should carry. Never both. */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): { dark: boolean; village: boolean } {
  if (pref === 'village') return { dark: false, village: true };
  return { dark: pref === 'dark' || (pref === 'system' && prefersDark), village: false };
}
