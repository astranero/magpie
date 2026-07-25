// ─────────────────────────────────────────────
// A last-resort title for a capture with no usable one
// ─────────────────────────────────────────────
// Some pages give us nothing to title a capture with: a generic app name
// ("Google Gemini"), an empty <title>, or a whole paragraph a site wrapped in a
// heading tag (a runaway that would otherwise become a giant, ugly title). When
// there is genuinely no real title to use, a short whimsical one — on the
// magpie/treasure-trove theme — beats a wall of text or "Untitled".
//
// This ONLY ever names a capture; it never replaces captured body content. No
// dependency (a curated list beats pulling a name-generator package for ~15
// strings) and no network — safe under the extension CSP.

const FUNNY_TITLES = [
  'A Shiny Thing I Found',
  'Something the Magpie Grabbed',
  'Untitled Treasure',
  'A Curious Clipping',
  'Loot from the Open Web',
  'One More Shiny Bit',
  'Fresh from the Nest',
  'A Bookmark With No Name',
  'Snagged Mid-Flight',
  'Notes from the Canopy',
  'A Page Worth Hoarding',
  'Plucked from the Feed',
  'A Trinket for the Trove',
  'This Caught My Eye',
  'Filed Under: Ooh, Shiny',
];

/**
 * Does this title need replacing with a fun fallback? True when it is empty,
 * suspiciously short, or so long it is really a paragraph (a runaway heading).
 * A caller that also has a generic-title check should OR this with that.
 */
export function titleIsUnusable(title: string, maxLen = 120): boolean {
  const t = (title || '').trim();
  return t.length < 3 || t.length > maxLen;
}

/**
 * A short whimsical title. `seed` (e.g. the page URL) makes the choice stable
 * for a given page — the same capture keeps the same fun name across re-runs —
 * without needing Math.random. With no seed, falls back to a rotating pick.
 */
export function funnyCaptureTitle(seed?: string): string {
  let idx: number;
  if (seed && seed.length > 0) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    idx = Math.abs(h) % FUNNY_TITLES.length;
  } else {
    idx = Math.floor(Math.random() * FUNNY_TITLES.length);
  }
  return FUNNY_TITLES[idx];
}
