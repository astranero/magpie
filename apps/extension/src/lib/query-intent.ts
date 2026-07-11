// ─────────────────────────────────────────────
// Question intent resolution — heuristics (pure)
// ─────────────────────────────────────────────
// Follow-up questions ("how to use it?", "I mean the skill Pro Max") carry
// no retrieval signal by themselves: BM25/vector search, page-section
// selection, and link scoring all see only pronouns. The service worker
// rewrites such questions into standalone ones with one small LLM call —
// these helpers decide WHEN that call is worth making.

/** Pronouns and deictic phrases that only resolve against prior context. */
const DEICTIC_RE = /\b(it|its|this|that|these|those|them|they|he|she|him|her|the (page|skill|tool|repo|site|article|paper|library|project|one)|the above|previous|earlier)\b/i;

/** Elliptical openers that continue a prior turn rather than start fresh. */
const CONTINUATION_RE = /^(and|also|what about|how about|why not|then|so|but|ok(ay)?[, ]|now|next|more|again|i mean\b)/i;

/**
 * True when the question likely depends on conversation/page context and
 * should be rewritten before retrieval. Requires prior history — the first
 * message of a chat has nothing to resolve against.
 */
export function needsIntentResolution(prompt: string, historyLength: number): boolean {
  if (historyLength === 0) return false;
  const p = (prompt || '').trim();
  if (p.length === 0) return false;
  if (p.startsWith('/')) return false;                 // commands are routed, not searched
  if (CONTINUATION_RE.test(p)) return true;
  if (DEICTIC_RE.test(p)) return true;
  // Very short questions are almost always elliptical follow-ups
  if (p.split(/\s+/).length <= 3) return true;
  return false;
}

/** Compact history block for the rewrite prompt. */
export function formatHistoryForIntent(history: Array<{ role: string; content: string }>, maxTurns = 6, maxChars = 350): string {
  return history
    .slice(-maxTurns)
    .map(m => `${m.role}: ${m.content.slice(0, maxChars)}`)
    .join('\n');
}

// ─────────────────────────────────────────────
// GitHub repository context (pure parts)
// ─────────────────────────────────────────────

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Branch when the URL pins one (…/tree/<branch>/…); undefined = default. */
  branch?: string;
}

/** Extract owner/repo(/branch) from any github.com page URL, else null. */
export function parseGitHubRepo(url: string): GitHubRepoRef | null {
  const m = (url || '').match(
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+))?(?:[/?#]|$)/
  );
  if (!m) return null;
  const [, owner, repo, branch] = m;
  // Non-repo top-level paths (orgs, marketplace, settings…) have no second segment match anyway;
  // filter obvious non-repo "repos".
  if (['topics', 'collections', 'features', 'marketplace', 'orgs', 'settings', 'notifications', 'sponsors'].includes(owner)) return null;
  return { owner, repo, branch };
}

/**
 * Choose which tree paths to inline for the model. Small trees go in whole.
 * Large trees keep every path matching a question keyword plus the head of
 * the tree (top levels first), inside a character budget.
 */
export function selectTreePaths(paths: string[], question: string, budget = 6_000): { selected: string[]; truncated: boolean } {
  const total = paths.length;
  const joined = paths.join('\n');
  if (joined.length <= budget) return { selected: paths, truncated: false };

  const keywords = (question || '')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter(w => w.length > 3);

  const matches = keywords.length > 0
    ? paths.filter(p => { const lp = p.toLowerCase(); return keywords.some(k => lp.includes(k)); })
    : [];

  // Shallow-first head: top-level files/dirs orient the model best
  const byDepth = [...paths].sort((a, b) =>
    (a.split('/').length - b.split('/').length) || a.localeCompare(b)
  );

  const selected: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  const push = (p: string) => {
    if (seen.has(p) || used + p.length + 1 > budget) return;
    seen.add(p);
    selected.push(p);
    used += p.length + 1;
  };
  matches.forEach(push);       // question-relevant paths always make the cut
  byDepth.forEach(push);       // then fill with the shallow head

  return { selected, truncated: selected.length < total };
}

/** Render the tree block injected into the system prompt. */
export function formatTreeBlock(ref: GitHubRepoRef, paths: string[], truncated: boolean): string {
  return (
    `\n\n--- REPOSITORY FILE TREE (${ref.owner}/${ref.repo}, from the GitHub API; NOT saved) ---\n` +
    paths.join('\n') +
    (truncated ? `\n[… tree truncated — paths matching the question are all included]` : '') +
    `\n--- END FILE TREE ---\n` +
    `Use this to answer questions about where files live in the repository. ` +
    `If a file is not in the tree, say it does not exist in the repo rather than guessing a location.`
  );
}
