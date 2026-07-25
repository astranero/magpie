// ─────────────────────────────────────────────
// Salvaging structured data Readability throws away
// ─────────────────────────────────────────────
// Readability scores candidates by PROSE density — it is built to find the
// article in a news page. A specification sheet is the opposite shape: dozens of
// two-or-three-word cells with no sentences. It scores near zero and gets
// dropped, so a vehicle listing captures its description paragraph and silently
// loses the year, mileage, engine size and price — the only part anyone wanted.
//
// It is not a failure of extraction, so no fallback fires: `article.content` is
// non-empty and looks fine. The data is simply gone.
//
// This runs alongside Readability and appends what it dropped. Same shape as
// the link-salvage already in content.ts ("link-rich DOM but link-poor
// markdown → append the links"), for the same reason.
//
// Uses only basic DOM APIs (querySelectorAll / children / textContent) so the
// same code runs against a real DOM in the content script and against linkedom
// in the parse worker. No innerText — linkedom does not implement it.

/** One label/value pair recovered from the page. */
export interface SpecRow { label: string; value: string }

export interface SalvageOptions {
  /** Skip rows whose label and value are both already present. */
  existingMarkdown?: string;
  /** Hard cap on rows, so a pathological page can't produce a huge document. */
  maxRows?: number;
}

const MAX_ROWS_DEFAULT = 80;
const MAX_LABEL = 60;
const MAX_VALUE = 200;

/** Collapse whitespace; DOM text is full of layout newlines and NBSPs. */
function txt(node: { textContent?: string | null } | null | undefined): string {
  return (node?.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** A cell that reads like a label or value: present, short, not a paragraph. */
function isCellish(s: string, max: number): boolean {
  if (!s || s.length > max) return false;
  // Two or more sentences means prose, which Readability already kept.
  return (s.match(/[.!?](\s|$)/g) || []).length < 2;
}

/** Elements that are never page data. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'HEADER', 'FORM', 'BUTTON', 'SELECT', 'OPTION']);

function inSkippedRegion(el: any): boolean {
  for (let n = el; n; n = n.parentElement) {
    if (SKIP_TAGS.has((n.tagName || '').toUpperCase())) return true;
  }
  return false;
}

/** Element children only (linkedom and the DOM both expose `children`). */
function kids(el: any): any[] {
  return Array.from(el?.children || []);
}

/**
 * Descend through pure wrapper elements — a div whose only job is to hold one
 * child. Real markup nests these several deep for layout:
 *
 *   <div class="…__details">            ← layout wrapper, 1 child
 *     <div class="vehicle-info-box">    ← the actual row, 2 children
 *       <div class="…__vehicle-info">Mittarilukema</div>
 *       <div class="…__vehicle-det">71 000 km</div>
 *
 * Checking a row's cell count without unwrapping sees ONE child and skips it,
 * so an entire spec table is invisible one level up. Bounded depth: a deep
 * single-child chain is layout, not data.
 */
function unwrap(el: any, maxDepth = 4): any {
  let node = el;
  for (let i = 0; i < maxDepth; i++) {
    const cs = kids(node);
    if (cs.length !== 1) break;
    node = cs[0];
  }
  return node;
}

/** True when the element has no element children carrying text — a leaf cell. */
function isLeafCell(el: any): boolean {
  const cs = kids(el);
  if (cs.length === 0) return true;
  // A label wrapped in <strong>/<span> is still a leaf for our purposes.
  return cs.every(c => kids(c).length === 0 && txt(c).length <= MAX_VALUE);
}

/** `<dl><dt>label</dt><dd>value</dd>` — the semantic version of a spec sheet. */
function fromDefinitionLists(doc: any): SpecRow[] {
  const out: SpecRow[] = [];
  for (const dl of Array.from(doc.querySelectorAll?.('dl') || []) as any[]) {
    if (inSkippedRegion(dl)) continue;
    let pendingLabel = '';
    for (const child of kids(dl)) {
      const tag = (child.tagName || '').toUpperCase();
      if (tag === 'DT') pendingLabel = txt(child);
      else if (tag === 'DD' && pendingLabel) {
        const value = txt(child);
        if (isCellish(pendingLabel, MAX_LABEL) && value) out.push({ label: pendingLabel, value });
        pendingLabel = '';
      }
    }
  }
  return out;
}

/**
 * Div grids, the case Readability actually loses. Two shapes cover almost all
 * of them:
 *   (a) a row element wrapping exactly two leaf cells, repeated;
 *   (b) a container of leaf cells in label, value, label, value order — the
 *       CSS-grid spec sheet, where nothing wraps a "row" at all.
 * Both need at least 3 pairs, which is what separates a spec table from two
 * stray sibling divs.
 */
function fromDivGrids(doc: any): SpecRow[] {
  const out: SpecRow[] = [];
  const seenContainers = new Set<any>();

  for (const el of Array.from(doc.querySelectorAll?.('div, ul, section, table') || []) as any[]) {
    if (seenContainers.has(el) || inSkippedRegion(el)) continue;
    const children = kids(el);
    if (children.length < 3) continue;

    // (a) repeated two-cell rows
    const rows: SpecRow[] = [];
    let twoCellRows = 0;
    for (const rawRow of children) {
      const row = unwrap(rawRow);
      const cells = kids(row);
      // 2 OR 3 cells: real markup splits a value across two elements often
      // enough (value + unit, value + qualifier) that requiring exactly two
      // misses whole tables. First cell is the label, the rest is the value.
      if (cells.length < 2 || cells.length > 3) continue;
      const label = txt(cells[0]);
      const value = cells.slice(1).map(txt).filter(Boolean).join(' ');
      if (isCellish(label, MAX_LABEL) && isCellish(value, MAX_VALUE) && label && value && label !== value) {
        rows.push({ label, value });
        twoCellRows++;
      }
    }
    if (twoCellRows >= 3 && twoCellRows >= children.length / 2) {
      out.push(...rows);
      seenContainers.add(el);
      continue;
    }

    // (b) flat label,value,label,value sequence
    if (children.length >= 6 && children.length % 2 === 0 && children.every(isLeafCell)) {
      const flat: SpecRow[] = [];
      let ok = true;
      for (let i = 0; i < children.length; i += 2) {
        const label = txt(children[i]);
        const value = txt(children[i + 1]);
        if (!isCellish(label, MAX_LABEL) || !isCellish(value, MAX_VALUE) || !label || !value) { ok = false; break; }
        flat.push({ label, value });
      }
      if (ok && flat.length >= 3) {
        out.push(...flat);
        seenContainers.add(el);
      }
    }
  }
  return out;
}

/**
 * JSON-LD (`schema.org`) — the highest-quality source when a listing publishes
 * it, because it is the site's own structured description rather than a guess
 * at its layout. Scalars only: nested objects are the site's plumbing.
 */
export function fromJsonLd(raw: string[]): SpecRow[] {
  const out: SpecRow[] = [];
  const push = (label: string, v: unknown) => {
    if (typeof v === 'string' || typeof v === 'number') {
      const value = String(v).replace(/\s+/g, ' ').trim();
      if (value && isCellish(label, MAX_LABEL) && value.length <= MAX_VALUE) out.push({ label, value });
    }
  };
  const walk = (node: any, depth: number) => {
    if (!node || depth > 3) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth)); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      // `@graph` is the container almost every real site wraps its nodes in —
      // skipping it (as a plain `@`-key) threw away the entire payload. Descend.
      if (k === '@graph') { walk(v, depth); continue; }
      if (k.startsWith('@')) continue;
      if (v && typeof v === 'object') walk(v, depth + 1);
      else push(k, v);
    }
  };
  for (const block of raw) {
    try { walk(JSON.parse(block), 0); } catch { /* a malformed block is not worth failing the capture over */ }
  }
  return out;
}

/**
 * The seller's free-text description — the "is this a good bike?" text — is
 * PROSE inside a nested div. Readability drops it (it scores the div beside the
 * spec grid as low-density) and `fromJsonLd` drops it too (over the 200-char
 * cell cap). So the one part the reader asked about is lost twice. Recover it
 * whole, as prose, from whichever the site publishes:
 *   - JSON-LD `description` / `articleBody` (Product/Vehicle/Offer/Article),
 *   - DOM `[itemprop="description"]` (schema.org microdata, site-agnostic).
 * Returns the longest candidate, or '' if none is substantial.
 */
const DESC_KEYS = new Set(['description', 'articleBody', 'text', 'reviewBody']);

export function fromJsonLdDescription(raw: string[]): string {
  let best = '';
  const walk = (node: any, depth: number) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth)); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '@graph') { walk(v, depth); continue; }
      if (DESC_KEYS.has(k) && typeof v === 'string') {
        const t = v.replace(/\s+/g, ' ').trim();
        if (t.length > best.length) best = t;
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  for (const block of raw) {
    try { walk(JSON.parse(block), 0); } catch { /* malformed block: skip */ }
  }
  return best;
}

// schema.org microdata first (site-agnostic), then common marketplace
// description containers. Lowercase-only substrings so linkedom (parse worker)
// and the live DOM both match; a bad selector is caught per-selector below.
const DESC_SELECTORS = [
  '[itemprop="description"]',
  '[class*="ilmoitusteksti"]',      // Finnish "listing text" (nettiauto)
  '[class*="note-disc"]',           // nettimoto seller note (short-note-disc / full-note-disc)
  '[class*="seller-note"]',
  '[class*="listing-description"]',
  '[class*="vehicle-description"]',
  '[class*="ad-description"]',
  '[class*="ad-text"]',
  '[class*="item-description"]',
  '[class*="listing-body"]',
  '[class*="description-text"]',
  '[data-testid*="description"]',
  '[id*="description"]',
  '[class*="description"]',          // broadest — last, only wins if it's the longest prose
];

export function fromDomDescription(doc: any): string {
  let best = '';
  for (const sel of DESC_SELECTORS) {
    let nodes: any[] = [];
    try { nodes = Array.from(doc?.querySelectorAll?.(sel) || []); } catch { continue; }
    for (const n of nodes) {
      const t = txt(n);
      // Require sentence-shaped prose so a class match that's really a label or
      // nav list doesn't win the "longest" contest.
      if (t.length > best.length && /[.!?]/.test(t)) best = t;
    }
  }
  return best;
}

const MAX_DESC = 4000;

/** Drop duplicates and anything the main extraction already carried. */
export function dedupeRows(rows: SpecRow[], existingMarkdown = ''): SpecRow[] {
  const haystack = existingMarkdown.replace(/\s+/g, ' ').toLowerCase();
  const seen = new Set<string>();
  const out: SpecRow[] = [];
  for (const r of rows) {
    // \u0000 as the separator: it cannot occur in page text, so two rows
    // cannot collide by having a label/value pair that spans the boundary.
    const key = `${r.label.toLowerCase()}\u0000${r.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Both halves already in the extracted text → Readability kept this one.
    if (haystack.includes(r.label.toLowerCase()) && haystack.includes(r.value.toLowerCase())) continue;
    out.push(r);
  }
  return out;
}

/** Markdown table. Pipes in a cell would break the row, so escape them. */
export function rowsToMarkdown(rows: SpecRow[]): string {
  if (rows.length === 0) return '';
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const body = rows.map(r => `| ${esc(r.label)} | ${esc(r.value)} |`).join('\n');
  return `\n\n## Details\n\n| | |\n| --- | --- |\n${body}\n`;
}

/**
 * Everything together: returns markdown to APPEND to the extracted content, or
 * '' when there was nothing Readability missed.
 *
 * `jsonLd` is passed in rather than read from the document because the content
 * script strips `<script>` from its clone before Readability runs.
 */
export function salvageSpecs(doc: any, jsonLd: string[] = [], opts: SalvageOptions = {}): string {
  const rows = [
    ...fromJsonLd(jsonLd),
    ...fromDefinitionLists(doc),
    ...fromDivGrids(doc),
  ];
  const deduped = dedupeRows(rows, opts.existingMarkdown).slice(0, opts.maxRows ?? MAX_ROWS_DEFAULT);
  let out = rowsToMarkdown(deduped);

  // The free-text description, recovered as prose. Only worth appending when it
  // is genuinely long (a short blurb Readability already keeps) and not already
  // in the captured markdown (probe the opening so we don't duplicate it).
  const desc = [fromJsonLdDescription(jsonLd), fromDomDescription(doc)]
    .reduce((a, b) => (b.length > a.length ? b : a), '');
  if (desc.length > MAX_VALUE) {
    const have = (opts.existingMarkdown || '').replace(/\s+/g, ' ').toLowerCase();
    const probe = desc.slice(0, 120).toLowerCase();
    if (!have.includes(probe)) out += `\n\n## Description\n\n${desc.slice(0, MAX_DESC)}\n`;
  }
  return out;
}

/** Read the page's JSON-LD blocks. Separate so callers can grab them pre-strip. */
export function readJsonLdBlocks(doc: any): string[] {
  const nodes = Array.from(doc?.querySelectorAll?.('script[type="application/ld+json"]') || []) as any[];
  return nodes.map(n => n.textContent || '').filter(Boolean);
}
