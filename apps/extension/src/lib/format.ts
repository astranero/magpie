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
