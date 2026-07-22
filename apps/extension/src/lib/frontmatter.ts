// ─────────────────────────────────────────────
// Frontmatter builder — Obsidian-compatible YAML
// ─────────────────────────────────────────────
// Every saved .md carries rich metadata in the SAME file so external tools
// (Obsidian, MCP servers, grep) can discover documents without sidecars.

export type DocKind =
  | 'web-capture'
  | 'youtube'
  | 'pdf'
  | 'selection'
  | 'local-import'
  | 'image'
  | 'deep-research'
  | 'research-sources'
  | 'skill'
  | 'lesson'
  | 'academic';

export interface FrontmatterFields {
  title: string;
  type: DocKind;
  source?: string;       // URL or origin label
  author?: string;       // byline / channel / paper authors
  captured?: string;     // ISO timestamp; defaults to now
  wordCount?: number;
  tags?: string[];       // extra tags beyond the defaults
  /** Extra scalar keys emitted verbatim before `tags:` — for document kinds
   *  that carry their own metadata (e.g. a lesson's number and coverage, read
   *  back to sequence a course). Values are YAML-escaped. */
  extra?: Record<string, string | number>;
}

function yamlEscape(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** Obsidian tags allow letters, digits, `_`, `-`, `/` — normalize the rest.
 *  Unicode-aware: the ASCII-only version turned non-Latin tags ("tutkimus",
 *  "研究") into empty strings. */
function toTag(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}_/-]+/gu, '-').replace(/^-+|-+$/g, '');
}

export function buildFrontmatter(f: FrontmatterFields): string {
  const captured = f.captured || new Date().toISOString();

  const tags = new Set<string>(['research-assistant', toTag(f.type)]);
  if (f.source) {
    try {
      const host = new URL(f.source).hostname.replace(/^www\./, '');
      if (host) tags.add(`source/${toTag(host)}`);
    } catch { /* non-URL source labels get no domain tag */ }
  }
  for (const t of f.tags || []) {
    const tag = toTag(t);
    if (tag) tags.add(tag);
  }

  const lines = ['---'];
  lines.push(`title: ${yamlEscape(f.title)}`);
  lines.push(`type: ${f.type}`);
  if (f.source) lines.push(`source: ${yamlEscape(f.source)}`);
  if (f.author) lines.push(`author: ${yamlEscape(f.author)}`);
  lines.push(`captured: ${captured}`);
  lines.push(`created: ${captured.slice(0, 10)}`);
  if (typeof f.wordCount === 'number') lines.push(`word_count: ${f.wordCount}`);
  for (const [k, v] of Object.entries(f.extra || {})) {
    lines.push(`${k}: ${typeof v === 'number' ? v : yamlEscape(String(v))}`);
  }
  lines.push('tags:');
  for (const t of tags) lines.push(`  - ${t}`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

/** True when the content already starts with a YAML frontmatter block. */
export function hasFrontmatter(content: string): boolean {
  return /^---\r?\n/.test(content.trimStart());
}

/**
 * True when the document's frontmatter tags include `tag` exactly.
 * Used to recognize machine-generated docs (tag `research-source`) so the
 * Lore list can group them and the local-folder mirror can skip them.
 */
export function contentHasTag(content: string, tag: string): boolean {
  const { yaml } = splitFrontmatter(content || '');
  if (!yaml) return false;
  return parseFrontmatterFields(yaml).tags.includes(tag);
}

// ── Frontmatter reading (shared by DocumentView, chunker, tests) ──

/** Tolerates BOM and leading whitespace before the opening fence. */
export const FRONTMATTER_REGEX = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a document into its YAML block (inner text, no fences) and body. */
export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const m = FRONTMATTER_REGEX.exec(content || '');
  if (!m) return { yaml: null, body: content || '' };
  return { yaml: m[1], body: content.slice(m[0].length) };
}

/**
 * Minimal YAML reader for the frontmatter WE write (buildFrontmatter):
 * "key: value" lines plus one "tags:" list of "  - tag" items. Values keep
 * their quotes stripped. Not a general YAML parser.
 */
export function parseFrontmatterFields(yaml: string): { fields: Array<[string, string]>; tags: string[] } {
  const fields: Array<[string, string]> = [];
  const tags: string[] = [];
  let inTags = false;
  for (const line of (yaml || '').split(/\r?\n/)) {
    const tagItem = line.match(/^\s+-\s+(.+)$/);
    if (inTags && tagItem) { tags.push(tagItem[1].trim()); continue; }
    inTags = false;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'tags') { inTags = true; continue; }
    const value = kv[2].replace(/^"(.*)"$/, '$1').trim();
    if (value) fields.push([kv[1].replace(/_/g, ' '), value]);
  }
  return { fields, tags };
}
