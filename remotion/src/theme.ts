// Palette + fonts mirrored from the actual extension (apps/extension —
// src/sidepanel/index.css default "feather white" theme + BrandMark). Teal-blue
// primary ("wing sheen"), violet "rule" accent, blue-black ink on white cards,
// Geist display. Kept in one place so every scene reads as the real product.

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const COLORS = {
  // dark cinematic stage = the app's own "plumage at night" dark bg
  bg: '#0E1220',
  bgWash: '#161B2B',
  // the real light UI surfaces
  panel: '#FFFFFF', // card: 0 0% 100%
  panelEdge: '#E6EBF1', // border-ish
  ink: '#171A2B', // foreground 226 30% 13%
  inkSoft: '#3B4257',
  muted: '#61697F', // muted-foreground 222 14% 44%
  line: 'rgba(23,26,43,0.10)', // border 216 18% 88% at low alpha
  // brand
  primary: '#0D6E9D', // primary 200 85% 34% — wing-sheen teal-blue
  primaryDeep: '#0A5578',
  primaryWash: '#E2EEF6',
  rule: '#7C4DD1', // --rule 262 65% 56% — violet signature rule
  ruleWash: '#EFE8FB',
  good: '#2E8B57', // success (quiz correct)
  chip: '#EEF1F6',
  // legacy aliases kept so scenes need no churn:
  get green() { return this.primary; },
  get greenDeep() { return this.primaryDeep; },
  get greenWash() { return this.primaryWash; },
  get gold() { return this.rule; },
  get blue() { return this.primary; },
  get blueWash() { return this.primaryWash; },
} as Record<string, string>;

// Geist is the default theme's display+body face (bundled in the app). Not
// installed here, so it falls back to the same system sans the app falls back to.
export const FONT_DISPLAY =
  '"Geist", "Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const FONT_SANS =
  '"Geist", "Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const FONT_MONO =
  '"Geist Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

// Scene durations, in frames. The sum is the video length (see Root.tsx).
export const SCENES = {
  hero: 90,
  capture: 240,
  research: 270,
  chat: 270,
  teach: 270,
  flashcard: 240,
  data: 300,
  drive: 240,
  outro: 240,
} as const;

export const TOTAL = Object.values(SCENES).reduce((a, b) => a + b, 0);
