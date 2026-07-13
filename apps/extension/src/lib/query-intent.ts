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

/**
 * True for greetings / acknowledgements / small talk — messages that should be
 * answered conversationally, NOT run through source retrieval (which returns
 * weak chunks and trips the strict "cannot answer from sources" refusal).
 * Conservative: only short messages made ENTIRELY of chit-chat tokens match, so
 * real short questions ("what is TLS") are never misclassified. Includes a few
 * Finnish greetings (moi/hei/terve/kiitos).
 */
const CHITCHAT_RE = /^(hi+|hey+|hello+|yo|sup|hiya|howdy|heya|moi+|hei+|terve|moro|morning|good\s*(morning|afternoon|evening|day|night)|thank\s*you|thanks?|thx|ty|cheers|kiitos|kiitti|how\s*(are|r)\s*(you|u|ya)|how'?s\s*it\s*going|how\s*are\s*things|what'?s\s*up|wassup|whats\s*up|bye+|goodbye|see\s*ya|good\s*bye|ok(ay)?|k|cool|nice|great|awesome|sweet|perfect|lol|haha+|hah|hmm+|yay)[\s!.,?]*$/i;

export function isChitchat(prompt: string): boolean {
  const p = (prompt || '').trim();
  if (p.length === 0 || p.length > 40 || p.startsWith('/')) return false;
  return CHITCHAT_RE.test(p);
}

/**
 * Did the model refuse a workspace-grounded turn for lack of sources? Tight
 * patterns matching the citation-branch refusal shapes ("This information was
 * not found in your sources.", "I cannot answer this based on the provided
 * sources.") so a normal answer that merely mentions "sources" doesn't trip it.
 * Chat uses this to escalate a grounded turn to a live web search — the
 * reliable net behind the score-based confidence gate.
 */
export function isRefusalAnswer(text: string): boolean {
  const t = (text || '').toLowerCase().trim();
  if (t.length === 0 || t.length > 600) return false; // real answers run longer than a bare refusal
  return /\b(can(?:not|'t)|could\s?n(?:o|')t|unable to|do(?:n'?t| not)|does(?:n'?t| not))\b[^.]*\banswer\b/.test(t)
    || /\bnot\s+(found|available|present|included|mentioned|contained|specified|covered)\b[^.]*\b(source|document|workspace|material)/.test(t)
    // Reversed order + present-tense: "the sources do not contain / mention …"
    || /\b(source|document|workspace|material)s?\b[^.]*\b(do(?:n'?t| not)|does(?:n'?t| not))\s+(contain|include|mention|cover|have|specify|provide|address|discuss)/.test(t)
    || /\bthis information was not found\b/.test(t)
    || /\bno (relevant )?(information|answer|match|data)\b[^.]*\b(source|document|workspace)/.test(t);
}

/** Compact history block for the rewrite prompt. */
export function formatHistoryForIntent(history: Array<{ role: string; content: string }>, maxTurns = 6, maxChars = 350): string {
  return history
    .slice(-maxTurns)
    .map(m => `${m.role}: ${m.content.slice(0, maxChars)}`)
    .join('\n');
}

// ─────────────────────────────────────────────
// Repository context (pure parts) — GitHub, GitLab, Azure DevOps, Bitbucket
// ─────────────────────────────────────────────

export type RepoProvider = 'github' | 'gitlab' | 'azure' | 'bitbucket';

export interface RepoRef {
  provider: RepoProvider;
  /** Human label, e.g. "owner/repo" or "org/project/repo". */
  label: string;
  /** Provider-specific path pieces used by the fetcher. */
  owner: string;
  repo: string;
  /** Azure DevOps only: the project between org and repo. */
  project?: string;
  /** Branch when the URL pins one; undefined = default branch. */
  branch?: string;
}

const NON_REPO_GH_OWNERS = new Set(['topics', 'collections', 'features', 'marketplace', 'orgs', 'settings', 'notifications', 'sponsors']);

/** Extract a repository reference from a code-host page URL, else null. */
export function parseRepoUrl(url: string): RepoRef | null {
  const u = url || '';

  // GitHub: github.com/{owner}/{repo}[/tree|blob/{branch}]
  let m = u.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+))?(?:[/?#]|$)/);
  if (m) {
    const [, owner, repo, branch] = m;
    if (NON_REPO_GH_OWNERS.has(owner)) return null;
    return { provider: 'github', label: `${owner}/${repo}`, owner, repo, branch };
  }

  // GitLab: gitlab.com/{group[/subgroup…]}/{repo}[/-/tree|blob/{branch}]
  // The "/-/" separator segment would match [\w.-], so split on it FIRST.
  m = u.match(/^https?:\/\/(?:www\.)?gitlab\.com\/([^?#]+)/);
  if (m) {
    const [repoPart, actionPart] = m[1].split(/\/-\//, 2);
    const parts = repoPart.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2 || !parts.every(p => /^[\w.-]+$/.test(p))) return null;
    const branchMatch = actionPart?.match(/^(?:tree|blob)\/([^/?#]+)/);
    const path = parts.join('/');
    return {
      provider: 'gitlab',
      label: path,
      owner: parts.slice(0, -1).join('/'),
      repo: parts[parts.length - 1],
      branch: branchMatch ? branchMatch[1] : undefined
    };
  }

  // Azure DevOps: dev.azure.com/{org}/{project}/_git/{repo}[?version=GB{branch}]
  m = u.match(/^https?:\/\/dev\.azure\.com\/([\w.-]+)\/([\w.%-]+)\/_git\/([\w.%-]+)/);
  if (m) {
    const [, org, project, repo] = m;
    const branchMatch = u.match(/[?&]version=GB([^&#]+)/);
    return {
      provider: 'azure',
      label: `${org}/${decodeURIComponent(project)}/${decodeURIComponent(repo)}`,
      owner: org,
      project: decodeURIComponent(project),
      repo: decodeURIComponent(repo),
      branch: branchMatch ? decodeURIComponent(branchMatch[1]) : undefined
    };
  }

  // Bitbucket: bitbucket.org/{workspace}/{repo}[/src/{branch}]
  m = u.match(/^https?:\/\/(?:www\.)?bitbucket\.org\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/src\/([^/]+))?(?:[/?#]|$)/);
  if (m) {
    const [, owner, repo, branch] = m;
    return { provider: 'bitbucket', label: `${owner}/${repo}`, owner, repo, branch };
  }

  return null;
}

/**
 * Choose which tree paths to inline for the model. Small trees go in whole.
 * Large trees keep every path matching a question keyword plus the head of
 * the tree (top levels first), inside a character budget.
 */
export function selectTreePaths(paths: string[], question: string, budget = 12_000): { selected: string[]; truncated: boolean } {
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

const PROVIDER_NAMES: Record<RepoProvider, string> = {
  github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket'
};

const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tar|jar|wasm|onnx|bin|exe|dll|so|dylib|mp[34]|mov|avi|sqlite|db)$/i;

/**
 * Files in the tree the question is actually asking about. Explicit
 * filenames ("agent.json", "src/index.ts") win; exact basename matches rank
 * above substring hits. Binary files are never candidates.
 */
export function matchFilesInTree(paths: string[], question: string, max = 6): string[] {
  const filePaths = paths.filter(p => !p.endsWith('/') && !BINARY_EXT_RE.test(p));
  // Tokens that look like file names/paths: contain a dot or slash
  const fileTokens = (question.match(/[\w][\w./_-]*\.\w{1,8}/g) || []).map(t => t.toLowerCase());
  // Code identifiers ("handleCapture", "paper_rank", "deep-researcher"):
  // "where is the code for X" names a symbol/module, not a file — match it
  // against basenames so the file's contents can still be fetched.
  const identTokens = (question.match(/\b(?:[a-z]+[A-Z][A-Za-z]+|[a-z0-9]+(?:[_-][a-z0-9]+)+)\b/g) || [])
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 5 && !fileTokens.some(f => f.includes(t)));
  if (fileTokens.length === 0 && identTokens.length === 0) return [];

  const scored = filePaths
    .map(p => {
      const lower = p.toLowerCase();
      const base = lower.split('/').pop()!;
      const stem = base.replace(/\.\w{1,8}$/, '');
      let score = 0;
      for (const t of fileTokens) {
        const tBase = t.split('/').pop()!;
        // Bonuses stack: a path-qualified token ("cli/…/agent.json") must
        // outrank a mere basename twin elsewhere in the tree.
        if (base === tBase) score += 10;           // exact filename
        if (t.includes('/') && lower.endsWith(t)) score += 8;  // full path named
        else if (lower.includes(t) && t !== tBase) score += 2;
      }
      for (const t of identTokens) {
        const norm = t.replace(/[_-]/g, '');
        const stemNorm = stem.replace(/[_-]/g, '');
        if (stemNorm === norm) score += 6;         // module named after the symbol
        else if (stemNorm.includes(norm)) score += 3;
      }
      return { p, score, depth: p.split('/').length };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.depth - b.depth) || a.p.localeCompare(b.p));

  return scored.slice(0, max).map(x => x.p);
}

/** Render the tree block injected into the system prompt. */
export function formatTreeBlock(ref: RepoRef, paths: string[], truncated: boolean): string {
  return (
    `\n\n--- REPOSITORY FILE TREE (${ref.label}, from the ${PROVIDER_NAMES[ref.provider]} API; NOT saved) ---\n` +
    paths.join('\n') +
    (truncated ? `\n[… tree truncated — paths matching the question are all included]` : '') +
    `\n--- END FILE TREE ---\n` +
    `Use this to answer questions about where files live in the repository. ` +
    `If a file is not in the tree, say it does not exist in the repo rather than guessing a location.`
  );
}
