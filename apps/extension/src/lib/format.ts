// ─────────────────────────────────────────────
// Small pure formatting helpers (UI-agnostic, testable)
// ─────────────────────────────────────────────

/** Relative "time ago" label from an ISO timestamp. */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Resolve a POSIX-style relative path (with ./ and ../) against a base
 * directory. Pure — used by the markdown image inliner and unit-testable
 * without the File System Access API.
 */
export function resolveRelativePath(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir + '/' + rel : rel).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    else if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return decodeURIComponent(resolved.join('/'));
}

/**
 * Remove the deterministic "*Sources:*" footer that the chat stream appends to
 * saved assistant messages. Applied when history is fed BACK to the model —
 * left in, the model imitates the footer and the reply ends with two identical
 * "Sources:" lines (its copy + the real one).
 */
export function stripSourcesFooter(text: string): string {
  return (text || '').replace(/\n+---\n\*Sources:\*[^\n]*\s*$/, '');
}

/**
 * Remove a MODEL-HALLUCINATED trailing "Sources:" line that carries no actual
 * link (e.g. a greeting that ends with "Sources: hi"). The real, deterministic
 * footer we append always contains a markdown link, so a trailing Sources line
 * WITHOUT `](` is never ours — strip it. Leaves genuine linked footers intact.
 */
export function stripBareSourcesFooter(text: string): string {
  const t = text || '';
  const m = t.match(/\n+\s*(?:-{3,}\s*)?\*{0,2}Sources?:?\*{0,2}\s*(.*)$/is);
  if (!m) return t;
  // If the trailing block contains a markdown/explicit link, keep it — it's a real footer.
  if (/\]\(|https?:\/\//.test(m[1])) return t;
  return t.slice(0, m.index).replace(/\s+$/, '');
}

/**
 * Strip a SINGLE trailing "Sources: …" line the model appended, whether or not
 * it contains links (e.g. "Sources: lushbinary.com · zylos.ai" or
 * "*Sources:* [x](url) · [y](url)"). Used when the web/page-links footer is
 * turned off — the user wants "Sources" to mean their saved library only, and
 * library citations render as separate [n] chips (never a literal "Sources:"
 * text line), so this is safe for every branch. Only a single trailing line is
 * removed (bounded length), never multi-paragraph content.
 */
export function stripAnySourcesFooter(text: string): string {
  return (text || '').replace(/\n+\s*(?:-{3,}\s*)?\*{0,2}Sources?:?\*{0,2}[^\n]{0,400}\s*$/i, '').replace(/\s+$/, '');
}
