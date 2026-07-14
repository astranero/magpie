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
 * Is this research topic genuinely scientific/scholarly? Deep research runs an
 * academic agent (Semantic Scholar / HuggingFace papers); for practical or
 * consumer topics ("game engines for a solo dev", "date ideas in Helsinki")
 * that agent pulls off-topic CS/paper results — often with garbled PDF text —
 * that drag the report down. Only include academic sources when the topic
 * clearly calls for research literature.
 */
export function isAcademicQuery(topic: string): boolean {
  return /\b(stud(?:y|ies)|research(?:ers?)?|evidence|clinical|trials?|meta-?analysis|peer[-\s]?reviewed|literature\s+review|systematic\s+review|efficacy|mechanisms?|hypothesis|empirical|scientific|biolog\w*|chemistr\w*|physics|neuroscience|genetics?|genomics?|epidemiolog\w*|pharmacolog\w*|molecular|proteins?|disease|pathophysiolog\w*|cognition|neural|quantum|theorem|equations?|academ\w*|papers?|journal|dataset)\b/i.test(topic || '');
}

/**
 * Is the user asking about their messages / inbox (as opposed to a workspace
 * doc)? When true and a webmail page is open, chat answers from the mailbox in
 * page context instead of running a pointless web search.
 */
export function isMessageQuery(prompt: string): boolean {
  return /\b(e-?mails?|inbox|messages?|gmail|who\s+(emailed|wrote|sent)|unread|my\s+mail)\b/i.test(prompt || '');
}

// ─────────────────────────────────────────────
// Page-context selection helpers (links / repo files)
// ─────────────────────────────────────────────

/** Words carrying no link/file-targeting signal, so a keyword match doesn't
 *  fire on "what/this/page/about/…". Lets "how much is their pricing?" map
 *  straight onto a "Pricing" link with no reranker round-trip. */
const LINK_STOPWORDS = new Set([
  'what', 'this', 'that', 'page', 'tell', 'about', 'how', 'much', 'many', 'does',
  'their', 'they', 'them', 'the', 'and', 'for', 'are', 'was', 'were', 'with',
  'from', 'into', 'your', 'you', 'have', 'has', 'can', 'could', 'would', 'should',
  'which', 'when', 'where', 'who', 'why', 'use', 'using', 'get', 'got', 'its',
  'more', 'info', 'information', 'give', 'show', 'explain', 'describe', 'current',
  'site', 'website', 'here', 'there', 'any', 'all', 'some', 'these', 'those',
  'work', 'works', 'like', 'want', 'need', 'find', 'look', 'inside', 'within',
]);

/** Content words from a question, for lexically matching link/file labels. */
export function questionKeywords(q: string): string[] {
  return [...new Set((q || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || [])].filter(w => !LINK_STOPWORDS.has(w));
}

/** True when a question keyword lands on a link's anchor text or its URL —
 *  the obvious "next hop" the user means (pricing → a Pricing link). */
export function lexicalLinkMatch(ref: { anchorText?: string; url: string }, keywords: string[]): boolean {
  const hay = `${ref.anchorText || ''} ${ref.url}`.toLowerCase();
  return keywords.some(k => hay.includes(k));
}

// Navigational concept groups: a "pricing" question should follow a link
// labelled "Plans" (and vice-versa) even though the words differ. Each group is
// a cluster of site-nav synonyms; a keyword in any group pulls in its siblings
// so lexicalLinkMatch catches the intended next hop. Links only — expanding
// these into FILE matching would mis-hit (a "plans" table ≠ pricing code).
const NAV_SYNONYMS: string[][] = [
  ['pricing', 'price', 'prices', 'cost', 'costs', 'plan', 'plans', 'tier', 'tiers', 'subscription', 'subscriptions', 'billing', 'payment', 'quote', 'credits', 'credit'],
  ['docs', 'documentation', 'guide', 'guides', 'reference', 'manual', 'tutorial', 'tutorials'],
  ['api', 'apis', 'sdk', 'endpoint', 'endpoints', 'developer', 'developers', 'integration', 'integrations'],
  ['about', 'company', 'team', 'mission', 'story'],
  ['features', 'feature', 'capabilities', 'product', 'how-it-works'],
  ['contact', 'support', 'help', 'faq'],
  ['download', 'install', 'getting-started', 'get-started', 'signup', 'sign-up', 'register'],
];

/** Expand question keywords with navigational synonyms for LINK matching, so a
 *  pricing question follows a "Plans"/"Billing" link (and a docs question a
 *  "Reference" link). No-op for keywords in no group. */
export function expandNavKeywords(keywords: string[]): string[] {
  const out = new Set(keywords);
  for (const kw of keywords) {
    for (const group of NAV_SYNONYMS) {
      if (group.includes(kw)) for (const w of group) out.add(w);
    }
  }
  return [...out];
}

/** Is the question about HOW something works / what's behind it — an
 *  implementation ask whose real answer lives in code, not marketing copy? On a
 *  product page that links to its repo, this is the signal to go read that repo. */
const IMPL_RE = /\b(how\s+(do(es)?|is|are|would|can)|what'?s?\s+behind|under\s+the\s+hood|behind\s+the\s+scenes?|mechanism|implement(s|ed|ation)?|architecture|back[- ]?end|server[- ]?side|source\s+code|code\s?base|internals?|works?\s+internally)\b/i;
export function isImplementationQuestion(q: string): boolean {
  return IMPL_RE.test(q || '');
}

/** Is the question location- or "near me"-dependent (weather, local info)? Used
 *  to decide whether to inject the user's place into a web search query. */
const LOCATION_RE = /\b(weather|forecast|temperature|climate|humidity|rain|snow|sunny|near\s?me|nearby|around\s+here|local(?:ly)?|closest|nearest|restaurants?|cafes?|coffee|bars?|hotels?|traffic|directions|things\s+to\s+do|open\s+now|gas\s+prices?|my\s+area)\b/i;
export function isLocationDependent(q: string): boolean {
  return LOCATION_RE.test(q || '');
}

/** Best-effort place name from an IANA timezone: "Europe/Helsinki" → "Helsinki",
 *  "America/Argentina/Buenos_Aires" → "Buenos Aires". A zero-config location hint
 *  when the user hasn't set one explicitly. Empty for non-geographic zones. */
export function timezoneToPlace(tz: string): string {
  if (!tz || !tz.includes('/')) return '';
  const city = tz.split('/').pop() || '';
  if (/^(UTC|GMT|Etc|Unknown)$/i.test(city)) return '';
  return city.replace(/_/g, ' ').trim();
}

// Strong page-referential phrases ("this project", "the docs", "on this site").
// Deliberately NOT bare pronouns — "is it cold today?" uses "it" expletively and
// must not be mistaken for a page question.
const PAGE_DEIXIS_RE = /\b(this|these|those)\s+(page|site|website|project|repo|repository|article|paper|docs?|documentation|company|product|tool|app|platform|framework|library|service|codebase|dataset)\b|\bthe\s+(page|site|website|repo|repository|article|documentation|codebase)\b|\bon\s+this\s+(page|site)\b/i;
/** Does the question explicitly refer to the page/site the user is viewing? */
export function mentionsPageDeixis(q: string): boolean {
  return PAGE_DEIXIS_RE.test(q || '');
}

/** Does the question share a content keyword with the page (title + body sample)?
 *  A cheap "is this plausibly about the page" signal for the intent router. */
export function overlapsPage(q: string, pageText: string): boolean {
  const kw = questionKeywords(q);
  if (!kw.length) return false;
  const hay = (pageText || '').toLowerCase();
  return kw.some(k => hay.includes(k));
}

/** Is the question ABOUT the current page itself (summarize / overview / gist /
 *  "what's the consensus of this page") rather than a topic to go look up? These
 *  must never trigger link-following or a forward search — the answer is the
 *  page. */
const PAGE_META_RE = /\b(summar(y|ise|ize|ies)|tl;?dr|overview|gist|consensus|recap|takeaways?)\b|\bwhat('?s| is| does| are)\b[^?]*\b(this|the)\s+page\b/i;
export function isPageMetaQuestion(q: string): boolean {
  return PAGE_META_RE.test(q || '');
}

/** First repository URL embedded in page text that parseRepoUrl accepts, if any.
 *  Lets a product/marketing page hand off implementation questions to its own
 *  source repo. */
export function findRepoUrlInText(text: string): string | null {
  const urls = (text || '').match(/https?:\/\/[^\s)"'<>\]]+/g) || [];
  for (const raw of urls) {
    const url = raw.replace(/[.,);]+$/, '');
    if (parseRepoUrl(url)) return url;
  }
  return null;
}

/** Is the question about a repo's layout / file locations (as opposed to what
 *  a specific file does)? Only for these do we inline the full file tree; other
 *  questions get file *contents* from the selector, not a path dump. */
const STRUCTURE_RE = /\b(where\s+(is|are|do|does|can)|file\s*tree|directory|directories|folders?|structure|layout|organi[sz]ed|architecture|list\s+(the\s+)?(files?|dirs?|folders?|modules?)|what\s+files?|which\s+files?|repo\s+(structure|layout|contents?))\b/i;
export function isStructureQuestion(q: string): boolean {
  return STRUCTURE_RE.test(q || '');
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
