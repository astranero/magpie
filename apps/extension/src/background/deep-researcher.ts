import { saveDocument, linkDocumentToProject, listDocuments } from '../lib/db';
import { chunkDocument, makeDocShortId } from '../lib/chunker';
import { buildFrontmatter } from '../lib/frontmatter';
import { addChunksToVectorStore, searchSessionChunks } from '../lib/vector-store';
import { getJob, updateJob, getPage, savePage, listPages } from '../lib/research-store';
import { pdfUrlToBody } from '../lib/pdf-parser';
import { checkContentQuality, extractDoi } from '../lib/quality-gate';
import { isAcademicQuery } from '../lib/query-intent';
import { getResearchLimits, getResearchDepth, getSynthesisCharBudget, getSourceQuality, getAcademicDepth, RESEARCH_LIMITS, ResearchLimits, SourceQuality, AcademicDepth } from '../lib/research-limits';
import { generateBibtex } from '../lib/bibtex';
import { harvestReferences, partitionRefs, HarvestedRef } from '../lib/reference-harvest';
import { getMcpServers, McpConnection, isSearchLikeTool, argsForQuery } from '../lib/mcp-client';
import { searchWithProviders, jinaWebSearch, getSearchApiKeys, SearchHit } from '../lib/search-providers';
import { rankPapers } from '../lib/paper-rank';
import { semaphore } from '../lib/semaphore';

// F9: serial indexing — one document at a time through the ONNX embedding
// pipeline. Even concurrency=2 causes WASM integer-overflow crashes when
// papers are long (NeurIPS-style full text = 25+ chunks each). Serial
// processing keeps peak WASM memory ~constant regardless of session size.
const indexingSem = semaphore(1);

// Hard cap on markdown length fed to the embedder per research source.
// ~60 k chars ≈ 15–20 k tokens — enough for a full abstract + methods
// section. Full papers that exceed this are still stored in full; only the
// embedding pass is truncated so ONNX never sees a single giant input.
const MAX_EMBED_CHARS = 60_000;

// Active tier for the current run — set at run start from Settings. A single
// research job runs at a time (enforced by the job store), so module state
// is safe here.
let activeLimits: ResearchLimits = RESEARCH_LIMITS.standard;
let activeQuality: SourceQuality = 'all';
let activeAcademicDepth: AcademicDepth = 'abstract';

/**
 * Shared citation contract with normal chat (lib/citations.ts): every chunk
 * is tagged with its real anchorId inside a <c> marker so the LLM can cite
 * `[anchorId]` inline. The synthesis report — including these source docs —
 * is persisted and linked into the project, so citation chips in the report
 * are clickable and jump to the exact excerpt, exactly like chat citations.
 */
export function buildAnchoredContext(chunks: { anchorId: string; docId: string; heading: string; text: string }[], titleByDoc?: Map<string, string>): string {
  let context = '';
  let currentDocId = '';
  for (const c of chunks) {
    if (c.docId !== currentDocId) {
      const label = titleByDoc?.get(c.docId);
      context += `\n[Source: ${label || c.docId}]\n`;
      currentDocId = c.docId;
    }
    context += `<c>${c.anchorId}</c> ${c.heading ? `${c.heading}\n` : ''}${c.text}\n\n`;
  }
  return context;
}

/** Titles for [Source: …] headers — citing a bare UUID is what the model
 *  does when a chunk's source label IS a bare UUID. */
async function docTitleMap(projectId: string): Promise<Map<string, string>> {
  try {
    const docs = await listDocuments(projectId);
    return new Map(docs.map(d => [d.id, d.title]));
  } catch {
    return new Map();
  }
}

const RESEARCH_CITATION_RULES =
  `CITATION RULES (mandatory — this report is graded on source-grounding, not confidence claims):\n` +
  `1. Every factual claim MUST end with the citation anchor of the excerpt it came from, e.g. "...grew 40% in 2023 [d3ab01.s1.p2]."\n` +
  `2. Citation format: [anchor_id] taken verbatim from the <c>anchor_id</c> tag preceding the excerpt you used. ONE anchor per bracket. For multiple corroborating sources write [anchor1][anchor2] — never comma-separate inside one bracket.\n` +
  `3. Never fabricate an anchor ID or cite one that wasn't given to you.\n` +
  `4. When multiple sources support the same claim, cite all of them — that IS the credibility signal. Do NOT use vague labels like "[High confidence]" or "[Low confidence]"; showing 2-3 independent anchors on a claim is more useful than a confidence tag.\n` +
  `5. If the excerpts don't cover a sub-point, OMIT it — do NOT pad the report with paragraphs or whole sections cataloguing what the sources "do not contain". At most ONE short clause noting a gap, and only when that gap is central to the question. Answering the covered parts well beats reciting the report's own gaps. Never lead a section with a disclaimer about missing data.\n` +
  `6. SOURCES DESCRIBE DIFFERENT SYSTEMS. Each [Source: …] block is a separate paper/page about its OWN system, method, or subject. NEVER merge mechanisms from different sources into one system as if they were parts of the same thing — attribute every mechanism, metric, and name to the specific system its source describes ("The X paper proposes…", "Separately, Y reports…").\n` +
  `7. If the research topic PRESUMES a connection the excerpts do not support (e.g. "how does system A use technique B" when no source shows A using B), state that mismatch plainly in the first paragraph instead of inventing the connection.\n` +
  `8. Ignore sources that are topically unrelated to the research question (a keyword match is not relevance) — do not force them into the narrative.\n` +
  `9. Do NOT write a Bibliography, References, or Sources section of your own — a source list is appended automatically. Citations appear ONLY as inline [anchor_id] brackets.\n`;

/**
 * Models sometimes append a hand-written "Bibliography"/"References" section
 * of bare doc-ids despite rule 9 — those aren't anchors, render as dead
 * brackets, and duplicate the auto-appended Sources list. Strip a trailing
 * section whose entries are bracket-led lines.
 */
export function stripModelBibliography(synthesis: string): string {
  const m = synthesis.match(/\n#{0,4}\s*\**\s*(Bibliography|References|Works Cited|Sources)\s*\**\s*\n/i);
  if (!m || m.index === undefined) return synthesis;
  const tail = synthesis.slice(m.index + m[0].length);
  const tailLines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  if (tailLines.length === 0) return synthesis;
  const bracketLed = tailLines.filter(l => /^(?:[-*]\s*)?\[[^\]]{1,40}\]/.test(l)).length;
  // Only strip when the section is clearly a citation list, not prose
  if (bracketLed / tailLines.length < 0.6) return synthesis;
  return synthesis.slice(0, m.index).trimEnd();
}

// ─────────────────────────────────────────────
// Deep Researcher — tab-free
// ─────────────────────────────────────────────
// Search + scraping run entirely via fetch() in the service worker.
// HTML → Markdown parsing is delegated to an invisible offscreen
// document (see src/offscreen/offscreen.ts). No browser tabs open.

// ── Offscreen document management ──

let offscreenReady: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const hasDoc = await chrome.offscreen.hasDocument?.();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.DOM_PARSER],
          justification: 'Parse fetched HTML into readable Markdown for deep research'
        });
      }
    })().catch(err => {
      offscreenReady = null;
      throw err;
    });
  }
  return offscreenReady;
}

interface ParsedPage {
  title: string;
  markdown: string;
  wordCount: number;
}

async function parseHtmlOffscreen(html: string, url: string): Promise<ParsedPage | null> {
  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_PARSE_HTML', html, url });
  if (res?.ok && res.markdown) {
    return { title: res.title, markdown: res.markdown, wordCount: res.wordCount };
  }
  return null;
}

// ── Fetch helpers ──

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function fetchText(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('AbortError'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchTextInner(url, controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchTextInner(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  // Accept html, text/*, xml (RSS/Atom feeds) and rss+xml. Reject binary types.
  if (type && !type.includes('html') && !type.includes('text') && !type.includes('xml')) {
    throw new Error(`Unsupported content-type: ${type}`);
  }
  return res.text();
}

/**
 * Domains to actively exclude from search results (low-quality content farms).
 */
const BLOCKED_DOMAINS = /duckduckgo\.com|youtube\.com|google\.com|pinterest\.com|quora\.com|reddit\.com\/r\/|facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com/;

/**
 * High-quality domains get prioritized in results ordering.
 */
const HIGH_QUALITY_DOMAINS = /arxiv\.org|nature\.com|science\.org|acm\.org|ieee\.org|springer\.com|wiley\.com|nih\.gov|gov\.\w+|edu$|\.ac\.|nytimes\.com|wired\.com|arstechnica\.com|hbr\.org|mckinsey\.com|mit\.edu|stanford\.edu|anthropic\.com|openai\.com|deepmind\.com|blog\.google|huggingface\.co|docs\./;

/**
 * Search the web without opening tabs, via DuckDuckGo's static HTML endpoint.
 * Result links are extracted from `uddg=` redirect params — no DOM needed.
 * Sources are sorted by domain quality.
 */
/** Extract result URLs from DDG html (raw) or its Jina-rendered markdown. */
export function extractSearchUrls(text: string): Set<string> {
  const urls = new Set<string>();

  // 1) DDG redirect params (raw HTML endpoint)
  const uddgRegex = /uddg=([^&"')\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = uddgRegex.exec(text)) !== null && urls.size < 12) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (decoded.startsWith('http') && !BLOCKED_DOMAINS.test(decoded) && !isJunkUrl(decoded)) urls.add(decoded);
    } catch { /* skip malformed */ }
  }

  // 2) Plain links (Jina reader markdown of the results page). Skip asset/schema
  //    junk (DDG's own doctype "http://www.w3.org/TR/html4/loose.dtd" leaked in).
  if (urls.size === 0) {
    const linkRegex = /https?:\/\/[^\s)"'\]<>]+/g;
    while ((m = linkRegex.exec(text)) !== null && urls.size < 12) {
      const u = m[0].replace(/[.,;]+$/, '');
      if (!BLOCKED_DOMAINS.test(u) && !/jina\.ai/.test(u) && !isJunkUrl(u)) urls.add(u);
    }
  }

  return urls;
}

/**
 * Search the web without opening tabs.
 * Primary: DuckDuckGo's static HTML endpoint. DDG now frequently answers with
 * a 202 anti-bot challenge (zero results), so fall back to fetching the same
 * results page through Jina Reader, which renders it server-side.
 */
async function performWebSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  // User-linked search APIs (Tavily/Brave/Serper) take priority — cleaner
  // results, snippets included, and no anti-bot roulette. No keys → scrape chain.
  try {
    const hits = await searchWithProviders(query, activeLimits.urlsPerQuery * 2, signal);
    if (hits.length > 0) {
      const sortedP = hits.sort((a, b) => {
        const aHigh = HIGH_QUALITY_DOMAINS.test(a.url) ? 0 : 1;
        const bHigh = HIGH_QUALITY_DOMAINS.test(b.url) ? 0 : 1;
        return aHigh - bHigh;
      });
      return sortedP.slice(0, activeLimits.urlsPerQuery);
    }
  } catch (e) {
    console.warn('Search providers failed, falling back to Jina search', e);
  }

  // Jina search — a real search API (clean, ranked results). s.jina.ai now
  // REQUIRES a key (401 without one), so only try it when the user set a Jina
  // key; otherwise skip straight to the DDG scrape chain (no wasted 401 call).
  try {
    const keys = await getSearchApiKeys();
    if (keys.jina) {
      const hits = await jinaWebSearch(query, activeLimits.urlsPerQuery * 2, signal, keys.jina);
      if (hits.length > 0) {
        const sorted = hits.sort((a, b) => (HIGH_QUALITY_DOMAINS.test(a.url) ? 0 : 1) - (HIGH_QUALITY_DOMAINS.test(b.url) ? 0 : 1));
        return sorted.slice(0, activeLimits.urlsPerQuery);
      }
    }
  } catch (e) {
    console.warn('Jina search failed, falling back to DDG scrape chain', e);
  }

  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let urls = new Set<string>();

  try {
    urls = extractSearchUrls(await fetchText(ddgUrl, 10000, signal));
  } catch (e) {
    console.warn(`Direct web search failed for "${query}"`, e);
  }

  if (urls.size === 0) {
    try {
      urls = extractSearchUrls(await fetchText(`https://r.jina.ai/${ddgUrl}`, 20000, signal));
    } catch (e) {
      console.warn(`Jina-proxied web search failed for "${query}"`, e);
    }
  }

  // site:-scoped queries frequently return nothing through the DDG scrape
  // chain — retry once with the operator stripped before giving up.
  if (urls.size === 0 && /\bsite:\S+/i.test(query)) {
    const bare = query.replace(/\bsite:\S+\s*/gi, '').trim();
    if (bare.length > 3) {
      try {
        urls = extractSearchUrls(await fetchText(`https://r.jina.ai/https://html.duckduckgo.com/html/?q=${encodeURIComponent(bare)}`, 20000, signal));
      } catch { /* fall through */ }
    }
  }

  // Sort: high-quality domains first
  let pool = [...urls];
  if (activeQuality === 'high') {
    const kept = pool.filter(u => HIGH_QUALITY_DOMAINS.test(u) || extractDoi(u) || /arxiv\.org/i.test(u));
    if (kept.length !== pool.length) {
      console.log(`[QUALITY] high-only: kept ${kept.length}/${pool.length} URLs for "${query}"`);
    }
    pool = kept;
  }
  const sorted = pool.sort((a, b) => {
    const aHigh = HIGH_QUALITY_DOMAINS.test(a) ? 0 : 1;
    const bHigh = HIGH_QUALITY_DOMAINS.test(b) ? 0 : 1;
    return aHigh - bHigh;
  });

  // DDG scrape yields URLs only — no snippet, so these callers must fetch.
  return sorted.slice(0, activeLimits.urlsPerQuery).map(url => ({ url }));
}

/**
 * News discovery via Google News RSS — keyless and reliable, unlike scraping
 * a search engine results page. Item links are news.google.com redirects that
 * resolve to the publisher when fetched with redirect: follow.
 */
async function searchGoogleNewsRss(query: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const xml = await fetchText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
      10000,
      signal
    );
    const urls: string[] = [];
    const itemRegex = /<item>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null && urls.length < activeLimits.newsMax) {
      const link = m[1].trim();
      if (link.startsWith('http')) urls.push(link);
    }
    return urls;
  } catch (e) {
    console.warn(`Google News RSS failed for "${query}"`, e);
    return [];
  }
}

/**
 * Fetch a page (or PDF) and convert it to Markdown.
 * Primary: Jina Reader (https://r.jina.ai) — free, no key, renders JS pages
 * and extracts text from PDFs, returns clean markdown.
 * Fallback: local fetch + offscreen Readability parse.
 */
export async function scrapeUrl(url: string, signal?: AbortSignal): Promise<ParsedPage | null> {
  let parsed: ParsedPage | null = null;

  // Google News RSS items are opaque redirect URLs; Jina answers them with
  // 403, burning its 20s timeout per article. Resolve the redirect locally
  // first so the publisher URL is what gets scraped (and cached/deduped).
  if (/news\.google\.com\/rss\//i.test(url)) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal, headers: FETCH_HEADERS });
      if (res.ok && res.url && !/news\.google\.com/i.test(res.url)) url = res.url;
    } catch { /* keep the original URL; the local path below still tries */ }
  }

  // 1) Jina Reader (skipped for unresolved Google News redirects — known 403)
  if (!/news\.google\.com/i.test(url)) {
    try {
      const md = await fetchText(`https://r.jina.ai/${url}`, 20000, signal);
      const cleaned = md.trim();
      if (cleaned.length > 200) {
        // Jina prepends "Title: ...\nURL Source: ...\nMarkdown Content:\n"
        const titleMatch = cleaned.match(/^Title:\s*(.+)$/m);
        const bodyIdx = cleaned.indexOf('Markdown Content:');
        const body = bodyIdx !== -1 ? cleaned.slice(bodyIdx + 'Markdown Content:'.length).trim() : cleaned;
        parsed = {
          title: titleMatch?.[1]?.trim() || url,
          markdown: body,
          wordCount: body.split(/\s+/).filter(Boolean).length
        };
      }
    } catch (e) {
      console.warn(`Jina Reader failed for ${url}, falling back`, e);
    }
  }

  // 2) Local fallback (skip binary PDFs — offscreen can't parse those)
  if (!parsed && !/\.pdf($|\?)/i.test(url)) {
    try {
      const html = await fetchText(url, 15000, signal);
      parsed = await parseHtmlOffscreen(html, url);
    } catch (e) {
      console.warn(`Failed to fetch ${url}`, e);
    }
  }

  // 3) Quality gate: anti-bot interstitials, paywalls, login walls, error
  //    pages, thin content. Rejected pages are never indexed. When the URL
  //    carries a DOI (ACM/IEEE/Springer/Wiley), fall back to Semantic
  //    Scholar's structured metadata instead of dropping the source.
  const gate = parsed ? checkContentQuality(parsed.markdown, parsed.title) : { pass: false, reason: 'unreachable' };
  if (!gate.pass) {
    const doi = extractDoi(url);
    if (doi) {
      const paper = await resolvePaperViaDoi(doi, signal);
      if (paper) {
        console.log(`[GATE] ${url} rejected (${gate.reason}) — recovered via DOI ${doi}`);
        return paperToParsedPage(paper);
      }
    }
    if (parsed) console.warn(`[GATE] Rejected ${url}: ${gate.reason}`);
    return null;
  }

  return parsed;
}

/**
 * One-shot web gather for an INTERACTIVE CHAT turn — a lightweight cousin of
 * the research pipeline. When a chat question has no workspace match and the
 * open page doesn't answer it, this runs a single web search (plus any enabled
 * search MCPs), scrapes a few top results, and returns numbered [W#] excerpts
 * the model can answer from and cite — instead of conceding to stale "general
 * knowledge". Tightly capped so chat stays responsive; every fetch honors the
 * abort `signal` (Stop / port disconnect). Failures degrade to fewer/no
 * snippets rather than throwing (except a real abort).
 */
export async function gatherWebSnippets(
  query: string,
  opts: { signal?: AbortSignal; onStatus?: (s: string) => void; deadlineMs?: number } = {}
): Promise<{ context: string; sources: { title: string; url: string }[] }> {
  const { signal, onStatus, deadlineMs = 10000 } = opts;
  const MAX_FETCH = 2;        // top results to actually scrape (chat wants speed)
  const PER_DOC_CHARS = 1500; // excerpt cap per source — enough to answer, cheap to send
  const blocks: string[] = [];
  const sources: { title: string; url: string }[] = [];

  // HARD DEADLINE — this runs on a chat turn's critical path. Jina/DDG scrapes
  // can each burn 15-20s; without a ceiling the panel sits "Searching the web…"
  // for a minute (looks frozen). One controller aborts every in-flight fetch at
  // the deadline; it's also chained to the caller's signal (Stop / disconnect).
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(new Error('web-fallback deadline')), deadlineMs);
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const inner = ac.signal;
  try {
  // 1) Web search. FAST PATH: answer straight from the providers' own snippets
  //    (Tavily/Brave/Serper) — no page fetch, so ~2s instead of ~10s. Only when
  //    snippets are thin (keyless DDG, which is url-only) do we scrape pages.
  const GOOD_SNIPPET = 120; // chars that suffice to answer without fetching
  try {
    onStatus?.('Searching the web…');
    const hits = await performWebSearch(query, inner);
    if (hits.length > 0) {
      onStatus?.(`Found ${hits.length} result${hits.length === 1 ? '' : 's'}…`);

      for (const h of hits.filter(h => (h.snippet || '').trim().length >= GOOD_SNIPPET).slice(0, MAX_FETCH + 2)) {
        const n = sources.length + 1;
        sources.push({ title: h.title || h.url, url: h.url });
        blocks.push(`[W${n}] ${h.title || h.url}\nURL: ${h.url}\n${(h.snippet || '').trim().slice(0, PER_DOC_CHARS)}`);
      }

      // Fell short on snippets → scrape a couple of pages (in parallel) to fill.
      if (blocks.length < 2) {
        const toScrape = hits.filter(h => (h.snippet || '').trim().length < GOOD_SNIPPET).slice(0, MAX_FETCH);
        if (toScrape.length > 0) {
          onStatus?.(`Reading ${toScrape.length} page${toScrape.length === 1 ? '' : 's'}…`);
          const parsed = await Promise.all(toScrape.map(h => scrapeUrl(h.url, inner).catch(() => null)));
          toScrape.forEach((h, i) => {
            const p = parsed[i];
            if (!p || !p.markdown.trim()) return;
            const n = sources.length + 1;
            sources.push({ title: p.title || h.url, url: h.url });
            blocks.push(`[W${n}] ${p.title || h.url}\nURL: ${h.url}\n${p.markdown.trim().slice(0, PER_DOC_CHARS)}`);
          });
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[chat web] search/scrape failed', e);
  }

  // NOTE: no MCP call here on purpose. Enabled MCPs (e.g. Context7 = code-library
  // docs) matched general chat questions and polluted answers — Context7 fuzzy-
  // matched "know" in "dramas I should know about" and returned code libraries.
  // MCP tools belong in /research (runMcpAgent), not a quick chat web fallback.
  } finally {
    clearTimeout(deadline);
  }

  return { context: blocks.join('\n\n---\n\n'), sources };
}

// ── LLM planning ──

/** Today, spelled out — models otherwise guess a date from their training era. */
function todayLine(): string {
  return `Today's date is ${new Date().toISOString().slice(0, 10)}.`;
}

export async function generateSearchQueries(topic: string, llmChatFn: (sys: string, user: string) => Promise<string>): Promise<string[]> {
  const sysPrompt = `${todayLine()} You are an expert research planner specializing in finding authoritative, high-quality sources. Given a topic, generate 7 precise web search queries that would surface:
- Academic papers and peer-reviewed research
- Technical documentation and official blog posts
- Expert analysis from reputable publications (Nature, IEEE, ACM, Wired, Ars Technica, HBR)
- Primary sources and official documentation

Avoid queries that would return social media, forums, or content farms. Include "site:" operators when targeting specific authoritative domains would be beneficial.

Return ONLY a JSON array of strings, nothing else. Example: ["query 1", "query 2"]`;
  const res = await llmChatFn(sysPrompt, topic);

  try {
    const start = res.indexOf('[');
    const end = res.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      const json = JSON.parse(res.slice(start, end + 1));
      if (Array.isArray(json)) return json.slice(0, 7);
    }
  } catch {
    console.warn('Failed to parse search queries from LLM:', res);
  }
  return [topic];
}

export async function generateSubQuestions(topic: string, llmChatFn: (sys: string, user: string) => Promise<string>): Promise<string[]> {
  const sysPrompt = `${todayLine()} You are a research strategist. Decompose the given topic into 5-7 research directives that together give comprehensive coverage: core mechanisms, current state of the art, applications, limitations, open debates, and recent developments.
Each directive is ONE sentence that starts with an action verb (Analyze / Investigate / Compare / Evaluate / Survey / Trace / Synthesize), names WHAT to examine, and ends with a purpose clause ("… to determine/extract/identify …"). Directives must be concrete enough to search on — name the specific systems, methods, or populations involved.
Return ONLY a JSON array of strings, nothing else.`;
  const res = await llmChatFn(sysPrompt, topic);
  try {
    const start = res.indexOf('[');
    const end = res.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      const json = JSON.parse(res.slice(start, end + 1));
      if (Array.isArray(json) && json.length > 0) return json.slice(0, 7);
    }
  } catch {
    console.warn('Failed to parse sub-questions from LLM:', res);
  }
  return [topic];
}

// ── Research source indexing ──
// Each scraped source is saved as a first-class document in the global library
// (same as a manual /capture) and linked to the active workspace.  This means:
//   • Citation anchor lookups (getChunkByAnchor → getDocument) always resolve.
//   • Sources appear in the Sources panel and survive session reloads.
//   • Nothing needs to be cleaned up — the user owns these documents.
async function indexResearchDoc(
  projectId: string,
  title: string,
  url: string,
  markdown: string,
  label: AgentLabel,
  bibtex?: string
): Promise<string> {
  const docType = label === 'ACADEMIC' ? 'academic' as const : 'web-capture' as const;
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  const fullMarkdown = buildFrontmatter({
    title: title || 'Untitled',
    type: docType,
    source: url || undefined,
    wordCount,
    tags: ['research-source', label.toLowerCase()]
  }) + markdown;

  const docShortId = makeDocShortId(crypto.randomUUID?.() ?? `${Date.now()}`);

  // Truncate the content fed to the embedder to avoid ONNX WASM overflow on
  // very long papers. The full content is stored in IndexedDB unchanged —
  // only the chunk set passed to the embedding pipeline is capped.
  const embedMarkdown = fullMarkdown.length > MAX_EMBED_CHARS
    ? fullMarkdown.slice(0, MAX_EMBED_CHARS) + '\n\n*(document truncated for embedding)*'
    : fullMarkdown;
  const rawChunks = chunkDocument({ docShortId, content: embedMarkdown });

  // Serial indexing gate — one document at a time through the ONNX pipeline.
  const { id: docId, chunks: savedChunks, isDuplicate } = await indexingSem(() => saveDocument({
    title: title || 'Untitled',
    url: url || '',
    content: fullMarkdown,   // always store full content
    capturedAt: new Date().toISOString(),
    favicon: '',
    wordCount,
    syncedToDrive: false,
    enabled: true,
    bibtex
  }, rawChunks));

  if (isDuplicate) {
    // Already in the GLOBAL library (e.g. captured by an earlier run in a
    // different project) — but this project still needs the link, or its
    // retrieval sees 0 docs after a research run full of dedup hits. The
    // vector store rehydrates the linked doc's stored chunks from IndexedDB
    // on the next search, so only the link is needed here.
    await linkDocumentToProject(projectId, docId);
    return docId;
  }

  await linkDocumentToProject(projectId, docId);
  await addChunksToVectorStore(projectId, savedChunks);
  return docId;
}

// ── Research agents (deep mode) ──

type AgentLabel = 'WEB' | 'ACADEMIC' | 'NEWS' | 'MCP';

// ── Structured source records ──
// Every captured source keeps its metadata (agent, quality tier, citations)
// instead of being flattened to a markdown string at collection time. The
// records feed both the report's Sources appendix and the standalone
// "Research Sources" document saved to the project.

export type SourceTier = 'high' | 'standard';

export interface SourceRecord {
  url: string;
  title: string;
  label: AgentLabel;
  docId: string;
  tier: SourceTier;
  citations?: number;
}

/**
 * Quality tier from signals that already exist in the pipeline — no new
 * scoring machinery. Everything indexed has already passed the content gate
 * (rejects never become records), so the honest distinction left is
 * high-authority vs standard. A third "low" tier would be fake precision.
 */
export function sourceTier(url: string, citations?: number): SourceTier {
  if ((citations ?? 0) >= 10) return 'high';
  if (HIGH_QUALITY_DOMAINS.test(url) || /arxiv\.org/i.test(url) || extractDoi(url)) return 'high';
  return 'standard';
}

/** Dedupe records: same document (docId) or same URL = same source. */
export function dedupeSourceRecords(records: SourceRecord[]): SourceRecord[] {
  const seen = new Set<string>();
  const out: SourceRecord[] = [];
  for (const r of records) {
    const key = r.docId || r.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Render a record as the markdown link used in the report's Sources list. */
function renderSourceEntry(r: SourceRecord): string {
  return sourceEntry(r.title, r.url);
}

/** Escape parens so a URL doesn't terminate a markdown link early. */
function escLinkUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * In the chat panel, inline `[shortId.sN.pM]` anchors resolve to clickable
 * citation chips at render time. A saved/exported markdown file has no such
 * resolver, so those anchors were dead raw text. Rewrite them into real
 * markdown links pointing at the cited source's URL, numbered in order of first
 * appearance so `[[3](url)]` lines up with `3.` in the Sources list.
 *
 * The anchor's short id is `makeDocShortId(record.docId)`, so we map anchors to
 * SourceRecords directly — no DB round-trip. Grouped `[a, b]` anchors (rare;
 * the synthesis prompt asks for individual brackets) are left as-is. Returns the
 * linked text plus the cited records in citation order.
 */
export function linkifyReportCitations(
  synthesis: string,
  records: SourceRecord[]
): { text: string; cited: SourceRecord[] } {
  const byShort = new Map<string, SourceRecord>();
  for (const r of records) {
    if (!r.docId) continue;
    const short = makeDocShortId(r.docId);
    if (!byShort.has(short)) byShort.set(short, r);
  }
  const numByShort = new Map<string, number>();
  const cited: SourceRecord[] = [];
  const re = /\[([a-z]\w{1,8})\.s\d+\.p\d+(?:\.\d+)?\]/gi;
  const text = synthesis.replace(re, (full, short: string) => {
    const rec = byShort.get(short);
    if (!rec) return full; // unknown anchor — leave untouched rather than drop it
    let n = numByShort.get(short);
    if (n === undefined) {
      n = cited.length + 1;
      numByShort.set(short, n);
      cited.push(rec);
    }
    return rec.url ? `[[${n}](${escLinkUrl(rec.url)})]` : `[${n}]`;
  });
  return { text, cited };
}

/**
 * URLs that can never be research sources: schema/DTD references, asset
 * files, tracker endpoints. These leak in from link extraction on scraped
 * pages (e.g. http://www.w3.org/TR/html4/loose.dtd).
 */
export function isJunkUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  if (/\.(dtd|xsd|css|js|ico|woff2?|ttf|svg|png|jpe?g|gif|webp)(\?|$)/i.test(url)) return true;
  if (/\/\/(www\.)?(w3\.org|schema\.org|purl\.org|xmlns\.com|ogp\.me)\//i.test(url)) return true;
  return false;
}

/** Markdown link for source lists: title when known, bare URL otherwise. */
function sourceEntry(title: string | undefined, url: string): string {
  const t = (title || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
  // Parens in URLs terminate markdown links early and corrupt the list
  const safeUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return t && t !== url ? `[${t}](${safeUrl})` : url;
}

interface AgentOutcome {
  label: AgentLabel;
  sources: SourceRecord[];
  docIds: string[];
}

/** Let queued extension messages (sidepanel clicks) run between heavy steps. */
const yieldToEventLoop = () => new Promise<void>(r => setTimeout(r, 0));

/** Scrape+index a list of URLs under an agent label. */
async function scrapeUrlList(
  projectId: string,
  urls: Iterable<string>,
  onProgress: (s: string) => void,
  signal: AbortSignal | undefined,
  label: AgentLabel
): Promise<AgentOutcome> {
  const cap = activeLimits.totalSourcesCap;
  const urlList = [...new Set(urls)].filter(u => !isJunkUrl(u)).slice(0, cap);
  const sources: SourceRecord[] = [];
  const docIds: string[] = [];
  let i = 1;
  for (const url of urlList) {
    if (signal?.aborted) throw new Error('AbortError');
    try {
      // Crash-safe resume: pages scraped before a worker/browser death are
      // served from the persistent job cache instead of the network.
      const cached = await getPage(url).catch(() => null);
      let title: string | undefined;
      let markdown: string | undefined;

      if (cached) {
        onProgress(`[${label}] Reading ${i}/${urlList.length} (cached): ${url}`);
        title = cached.title;
        markdown = cached.markdown;
      } else {
        onProgress(`[${label}] Reading ${i}/${urlList.length}: ${url}`);
        const scraped = await scrapeUrl(url, signal);
        if (scraped?.markdown) {
          title = scraped.title;
          markdown = scraped.markdown;
          await savePage({ url, title, markdown, label }).catch(() => {});
        }
      }

      if (markdown) {
        const docId = await indexResearchDoc(projectId, title || url, url, markdown, label);
        docIds.push(docId);
        sources.push({ url, title: title || url, label, docId, tier: sourceTier(url) });
        onProgress(`[${label}] ✓ Captured "${title}"`);
      } else {
        onProgress(`[${label}] ✗ No readable content: ${url}`);
      }
    } catch (e) {
      onProgress(`[${label}] ✗ Failed: ${url}`);
    }
    i++;
    await yieldToEventLoop();
  }
  return { label, sources, docIds };
}

/** One search+fetch cycle over the open web. */
async function runWebAgent(
  projectId: string,
  queries: string[],
  onProgress: (s: string) => void,
  signal: AbortSignal | undefined,
  label: AgentLabel
): Promise<AgentOutcome> {
  const allUrls = new Set<string>();
  for (const q of queries) {
    if (signal?.aborted) throw new Error('AbortError');
    onProgress(`[${label}] Searching: "${q}"`);
    const found = await performWebSearch(q, signal);
    found.forEach(h => allUrls.add(h.url));
    onProgress(`[${label}] → ${found.length} result(s)`);
    await new Promise(r => setTimeout(r, 800));
  }
  if (allUrls.size === 0) onProgress(`[${label}] Search returned no results (engine may be blocking)`);
  return scrapeUrlList(projectId, allUrls, onProgress, signal, label);
}

/** News agent: Google News RSS (keyless, no scraping of search pages). */
async function runNewsAgent(
  projectId: string,
  topic: string,
  onProgress: (s: string) => void,
  signal?: AbortSignal
): Promise<AgentOutcome> {
  onProgress(`[NEWS] Fetching Google News for: "${topic}"`);
  const urls = await searchGoogleNewsRss(topic, signal);
  if (urls.length === 0) onProgress('[NEWS] No news items found');
  return scrapeUrlList(projectId, urls, onProgress, signal, 'NEWS');
}

interface AcademicPaper {
  title: string;
  abstract: string;
  year: string;
  authors: string;
  url: string;
  venue?: string;
  doi?: string;
  citations?: number;
  influentialCitations?: number;
}

/**
 * Cap every keyless academic-API request at 25s (combined with the run's
 * abort signal). A hung socket to S2/CrossRef/HF otherwise stalls the whole
 * gathering stage with no way to time out.
 */
function apiSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(25_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Semantic Scholar Graph API. The free unauthenticated pool 429s constantly,
 * so retry with backoff; an optional `s2ApiKey` in chrome.storage.local is
 * sent as x-api-key for the much higher authenticated limit.
 */
async function s2Fetch(url: string, signal?: AbortSignal): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  try {
    const s = await chrome.storage.local.get(['s2ApiKey']);
    if (s.s2ApiKey) headers['x-api-key'] = s.s2ApiKey;
  } catch { /* storage unavailable in tests */ }

  const delays = [0, 2000, 8000];
  let res: Response | null = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
    if (signal?.aborted) throw new Error('AbortError');
    res = await fetch(url, { signal: apiSignal(signal), headers });
    if (res.status !== 429) break;
  }
  if (!res || !res.ok) throw new Error(`Semantic Scholar ${res ? res.status : 'unreachable'}`);
  return res.json();
}

function mapS2Paper(p: any): AcademicPaper {
  return {
    title: p.title || 'Untitled',
    abstract: p.abstract || '',
    year: p.year ? String(p.year) : '',
    authors: (p.authors || []).map((a: any) => a.name).filter(Boolean).join(', '),
    url: p.externalIds?.ArXiv ? `https://arxiv.org/abs/${p.externalIds.ArXiv}` : (p.url || ''),
    venue: p.venue || undefined,
    doi: p.externalIds?.DOI || undefined,
    citations: typeof p.citationCount === 'number' ? p.citationCount : undefined,
    influentialCitations: typeof p.influentialCitationCount === 'number' ? p.influentialCitationCount : undefined
  };
}

async function searchSemanticScholar(query: string, signal?: AbortSignal): Promise<AcademicPaper[]> {
  const data = await s2Fetch(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${activeLimits.s2Limit}&fields=title,abstract,year,authors,url,externalIds,venue,citationCount,influentialCitationCount`,
    signal
  );
  return (data.data || []).filter((p: any) => p.abstract).map(mapS2Paper);
}

/**
 * Resolve a paper by DOI — the anti-bot fallback. Publisher pages (ACM,
 * IEEE, Springer, Wiley) block scraping behind Cloudflare, but their DOIs
 * resolve to structured metadata on Semantic Scholar.
 */
async function resolvePaperViaDoi(doi: string, signal?: AbortSignal): Promise<AcademicPaper | null> {
  try {
    const p = await s2Fetch(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,abstract,year,authors,url,externalIds,venue,citationCount,influentialCitationCount`,
      signal
    );
    if (!p?.title) return null;
    const paper = mapS2Paper(p);
    return paper.abstract ? paper : null;
  } catch {
    return null;
  }
}

/** Build a scrapeable page from paper metadata when the real page is blocked. */
function paperToParsedPage(p: AcademicPaper): ParsedPage {
  const md = `# ${p.title}\n\n**Authors:** ${p.authors || 'Unknown'}${p.year ? ` (${p.year})` : ''}${p.venue ? `\n**Venue:** ${p.venue}` : ''}\n\n## Abstract\n\n${p.abstract}`;
  return { title: p.title, markdown: md, wordCount: md.split(/\s+/).filter(Boolean).length };
}

/**
 * CrossRef search — 150M+ records across 20k publishers, free, no key.
 * Abstracts arrive as JATS XML when present; strip the tags. Records
 * without an abstract are dropped (nothing to index).
 */
async function searchCrossRef(query: string, rows: number, signal?: AbortSignal): Promise<AcademicPaper[]> {
  if (rows <= 0) return [];
  const res = await fetch(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${rows}&filter=type:journal-article&select=title,abstract,author,issued,DOI,container-title,URL,is-referenced-by-count`,
    { signal: apiSignal(signal), headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`CrossRef ${res.status}`);
  const data = await res.json();
  const items: any[] = data?.message?.items || [];
  return items
    .filter(it => it.abstract && (it.title || [])[0])
    .map(it => ({
      title: it.title[0],
      abstract: String(it.abstract).replace(/<\/?jats:[^>]*>/g, '').replace(/<[^>]+>/g, '').trim(),
      year: String(it.issued?.['date-parts']?.[0]?.[0] || ''),
      authors: (it.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).join(', '),
      url: it.DOI ? `https://doi.org/${it.DOI}` : (it.URL || ''),
      venue: (it['container-title'] || [])[0],
      doi: it.DOI,
      citations: typeof it['is-referenced-by-count'] === 'number' ? it['is-referenced-by-count'] : undefined
    }))
    .filter(p => p.abstract.length > 80);
}

/** HuggingFace papers search — public endpoint, no key. */
async function searchHuggingFacePapers(query: string, signal?: AbortSignal): Promise<AcademicPaper[]> {
  const res = await fetch(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(query)}`, { signal: apiSignal(signal) });
  if (!res.ok) throw new Error(`HuggingFace ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data) ? data : [];
  return items.slice(0, activeLimits.hfLimit).map((item: any) => {
    const p = item.paper || item;
    return {
      title: p.title || 'Untitled',
      abstract: p.summary || p.abstract || '',
      year: (p.publishedAt || '').slice(0, 4),
      authors: (p.authors || []).map((a: any) => a.name || a.user || '').filter(Boolean).join(', '),
      url: p.id ? `https://huggingface.co/papers/${p.id}` : ''
    };
  }).filter((p: AcademicPaper) => p.abstract);
}

// ── arXiv full-text fetching ──

/**
 * Extract an arXiv paper ID from a URL.
 * Handles both:
 *   https://arxiv.org/abs/2401.12345   → "2401.12345"
 *   https://huggingface.co/papers/2401.12345 → "2401.12345"
 * Returns null if no arXiv ID can be extracted.
 */
function extractArxivId(url: string): string | null {
  const absMatch = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
  if (absMatch) return absMatch[1];
  const hfMatch = url.match(/huggingface\.co\/papers\/(\d{4}\.\d{4,5})/i);
  if (hfMatch) return hfMatch[1];
  return null;
}

/**
 * Fetch the full text of an arXiv paper by parsing its PDF.
 * Returns null on any failure — callers fall back to abstract-only.
 * OCR is intentionally skipped (no ocrFn) to keep research timing predictable.
 */
async function fetchArxivFullText(
  arxivId: string,
  signal?: AbortSignal,
  llmChatFn?: LlmChatFn
): Promise<string | null> {
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  try {
    if (signal?.aborted) throw new Error('AbortError');
    const body = await pdfUrlToBody(pdfUrl);
    const textOnly = body.replace(/## Page \d+\n\n\*\(no extractable text\)\*/g, '').trim();
    if (textOnly.length < 100) return null;

    // Optionally clean garbled PDF extraction with the LLM
    if (llmChatFn && isGarbledPdf(body)) {
      try {
        const cleaned = await cleanPdfText(body, llmChatFn);
        return buildCleanedPdfDoc(cleaned, body);
      } catch {
        // Cleanup failed — return raw extraction unchanged
      }
    }
    return body;
  } catch {
    return null;
  }
}

/** Academic agent: paper abstracts from Semantic Scholar + HuggingFace. */
async function runAcademicAgent(
  projectId: string,
  topic: string,
  onProgress: (s: string) => void,
  signal?: AbortSignal,
  llmChatFn?: LlmChatFn
): Promise<AgentOutcome> {
  const papers: AcademicPaper[] = [];

  // Resume: papers cached before a crash count even if the APIs are
  // rate-limiting us now. Build a URL→docId map from docs already in this
  // project so cached papers that are already indexed need zero work.
  const cachedSources: SourceRecord[] = [];
  const cachedDocIds: string[] = [];
  const cachedTitles = new Set<string>();
  try {
    // Fast path: docs already linked to the project — no IDB writes needed
    const existingDocs = await listDocuments(projectId);
    const urlToDocId = new Map(existingDocs.map(d => [d.url, d.id]));

    const cachedPages = (await listPages())
      .filter(p => p.label === 'ACADEMIC')
      .reverse(); // most recently saved first

    const cacheRestoreCap = Math.min(
      cachedPages.length,
      Math.floor(activeLimits.totalSourcesCap / 2)
    );
    let restored = 0;
    let alreadyLinked = 0;

    for (const page of cachedPages.slice(0, cacheRestoreCap)) {
      if (signal?.aborted) throw new Error('AbortError');

      const existingDocId = urlToDocId.get(page.url);
      let cachedDocId: string;
      if (existingDocId) {
        // Already in this project — just track it, no IDB work at all
        cachedDocId = existingDocId;
        alreadyLinked++;
      } else {
        // Not yet in project — index it (dedup in saveDocument avoids re-embedding)
        await yieldToEventLoop();
        cachedDocId = await indexResearchDoc(projectId, page.title, page.url, page.markdown, 'ACADEMIC');
        restored++;
      }
      cachedDocIds.push(cachedDocId);

      if (page.url.startsWith('http') && !isJunkUrl(page.url)) {
        cachedSources.push({ url: page.url, title: page.title, label: 'ACADEMIC', docId: cachedDocId, tier: sourceTier(page.url) });
      }
      cachedTitles.add(page.title.toLowerCase().trim());
    }

    const skipped = cachedPages.length - Math.min(cachedPages.length, cacheRestoreCap);
    if (alreadyLinked + restored > 0) {
      onProgress(
        `[ACADEMIC] Cache: ${alreadyLinked} already indexed, ${restored} new` +
        (skipped > 0 ? `, ${skipped} older skipped` : '')
      );
    }
  } catch { /* cache is best-effort */ }

  onProgress('[ACADEMIC] Searching Semantic Scholar…');
  try {
    papers.push(...await searchSemanticScholar(topic, signal));
  } catch (e: any) {
    onProgress(`[ACADEMIC] Semantic Scholar unavailable (${e.message}) — continuing`);
  }

  if (signal?.aborted) throw new Error('AbortError');
  onProgress('[ACADEMIC] Searching HuggingFace papers…');
  try {
    papers.push(...await searchHuggingFacePapers(topic, signal));
  } catch (e: any) {
    onProgress(`[ACADEMIC] HuggingFace papers unavailable (${e.message}) — continuing`);
  }

  if (activeLimits.crossrefRows > 0) {
    if (signal?.aborted) throw new Error('AbortError');
    onProgress('[ACADEMIC] Searching CrossRef…');
    try {
      papers.push(...await searchCrossRef(topic, activeLimits.crossrefRows, signal));
    } catch (e: any) {
      onProgress(`[ACADEMIC] CrossRef unavailable (${e.message}) — continuing`);
    }
  }

  const sources: SourceRecord[] = [...cachedSources];
  const docIds: string[] = [...cachedDocIds];
  const seen = new Set<string>(cachedTitles);

  // Deduplicate: prefer the entry with an arXiv URL when two sources return the
  // same paper (Semantic Scholar and HuggingFace often overlap).
  const deduped: AcademicPaper[] = [];
  for (const p of papers) {
    const key = p.title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  // Algorithmic quality ranking: citations, citation velocity, influential
  // citations, recency, full-text availability. ~30% of slots reserved for
  // the newest papers so fresh work isn't crowded out by citation counts.
  // Cap academic papers at the totalSourcesCap budget shared with web sources,
  // keeping a fair share (half) for academic to leave room for web/news.
  const academicCap = Math.min(
    activeLimits.s2Limit + activeLimits.hfLimit,
    Math.floor(activeLimits.totalSourcesCap / 2)
  );
  if (activeQuality === 'high') {
    const nowYear = new Date().getFullYear();
    const before = deduped.length;
    const kept = deduped.filter(p => (p.citations ?? 0) >= 10 || Number(p.year) >= nowYear - 1);
    // Only apply the floor when it doesn't starve the agent
    if (kept.length >= 5) {
      deduped.length = 0;
      deduped.push(...kept);
      onProgress(`[ACADEMIC] High-quality mode: ${kept.length}/${before} papers (≥10 citations or ≤1 year old)`);
    }
  }
  const rankedAll = rankPapers(
    deduped.map(p => Object.assign(p, { hasFullText: !!extractArxivId(p.url) })),
    academicCap
  );
  if (deduped.length > rankedAll.length) {
    const withCites = rankedAll.filter(p => (p.citations ?? 0) > 0);
    const avg = withCites.length ? Math.round(withCites.reduce((n, p) => n + (p.citations || 0), 0) / withCites.length) : 0;
    onProgress(`[ACADEMIC] Ranked ${deduped.length} papers → selected ${rankedAll.length} (avg ${avg} citations, ${rankedAll.filter(p => Number(p.year) >= new Date().getFullYear() - 1).length} from the last year)`);
  }
  deduped.length = 0;
  deduped.push(...rankedAll);
  // Full-text-first within the selection (fetch order only)
  deduped.sort((a, b) => (extractArxivId(a.url) ? 0 : 1) - (extractArxivId(b.url) ? 0 : 1));

  // Process papers serially — each embeds fully before the next starts.
  // Parallel batches (old BATCH=4) caused ONNX WASM integer-overflow crashes
  // on long papers because 4 × 25 chunks hit peak memory simultaneously.
  for (const p of deduped) {
    if (signal?.aborted) throw new Error('AbortError');
    await yieldToEventLoop();
    const key = p.title.toLowerCase().trim();
    const headerLine = `# ${p.title}\n\n**Authors:** ${p.authors || 'Unknown'}${p.year ? ` (${p.year})` : ''}${typeof p.citations === 'number' ? `\n**Citations:** ${p.citations}` : ''}${p.venue ? `\n**Venue:** ${p.venue}` : ''}`;
    const abstractSection = `## Abstract\n\n${p.abstract}`;
    let md = `${headerLine}\n\n${abstractSection}`;

    const arxivId = extractArxivId(p.url);
    if (arxivId && activeAcademicDepth === 'full') {
      onProgress(`[ACADEMIC] Fetching full text: "${p.title.slice(0, 60)}"`);
      const fullText = await fetchArxivFullText(arxivId, signal, llmChatFn);
      if (fullText) {
        const wasClean = fullText.includes('<details>');
        md = `${headerLine}\n\n${abstractSection}\n\n## Full Paper\n\n${fullText}`;
        onProgress(`[ACADEMIC] ✓ Full text captured${wasClean ? ' (cleaned)' : ''}: "${p.title.slice(0, 60)}"`);
      } else {
        onProgress(`[ACADEMIC] ✗ PDF unavailable, using abstract: "${p.title.slice(0, 60)}"`);
      }
    }

    // Use arXiv abs URL as canonical source when available
    const sourceUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : (p.url || '');
    const bibtex = generateBibtex({ title: p.title, authors: p.authors, year: p.year, doi: p.doi, venue: p.venue, url: sourceUrl || undefined });
    const paperDocId = await indexResearchDoc(projectId, p.title, sourceUrl, md, 'ACADEMIC', bibtex);
    docIds.push(paperDocId);
    if (sourceUrl) sources.push({ url: sourceUrl, title: p.title, label: 'ACADEMIC', docId: paperDocId, tier: sourceTier(sourceUrl, p.citations), citations: p.citations });
    await savePage({ url: sourceUrl || `paper:${key}`, title: p.title, markdown: md, label: 'ACADEMIC' }).catch(() => {});
  }

  onProgress(`[ACADEMIC] Indexed ${docIds.length} paper(s) (${deduped.filter(p => extractArxivId(p.url)).length} with full text)`);
  return { label: 'ACADEMIC', sources, docIds };
}

/**
 * MCP agent: user-registered MCP servers (Settings → MCP Servers) become an
 * extra discovery channel. Only enabled servers are contacted — enabling a
 * server is the permission grant. Only search-like tools receive the topic.
 */
async function runMcpAgent(
  projectId: string,
  topic: string,
  onProgress: (s: string) => void,
  signal?: AbortSignal
): Promise<AgentOutcome> {
  const sources: SourceRecord[] = [];
  const docIds: string[] = [];
  const servers = (await getMcpServers()).filter(s => s.enabled);
  if (servers.length === 0) return { label: 'MCP', sources, docIds };

  for (const server of servers) {
    if (signal?.aborted) throw new Error('AbortError');
    try {
      const conn = new McpConnection(server);
      const tools = (await conn.listTools()).filter(isSearchLikeTool).slice(0, 2);
      if (tools.length === 0) {
        onProgress(`[MCP] ${server.name}: no search-like tools — skipping`);
        continue;
      }
      for (const tool of tools) {
        if (signal?.aborted) throw new Error('AbortError');
        const args = argsForQuery(tool, topic);
        if (!args) { onProgress(`[MCP] ${server.name}/${tool.name}: no fillable query param — skipping`); continue; }
        onProgress(`[MCP] ${server.name}: calling ${tool.name}…`);
        try {
          const text = await conn.callTool(tool.name, args);
          const gate = checkContentQuality(text, `${server.name}/${tool.name}`);
          if (!gate.pass) {
            onProgress(`[MCP] ${server.name}/${tool.name}: result rejected (${gate.reason})`);
            continue;
          }
          const title = `MCP: ${server.name} — ${tool.name} ("${topic.slice(0, 60)}")`;
          const mcpDocId = await indexResearchDoc(projectId, title, server.url, text, 'MCP');
          docIds.push(mcpDocId);
          sources.push({ url: server.url, title, label: 'MCP', docId: mcpDocId, tier: 'standard' });
          onProgress(`[MCP] ✓ ${server.name}/${tool.name} returned usable content`);
        } catch (e: any) {
          onProgress(`[MCP] ✗ ${server.name}/${tool.name}: ${e.message}`);
        }
      }
    } catch (e: any) {
      onProgress(`[MCP] ${server.name} unreachable (${e.message}) — continuing`);
    }
  }
  return { label: 'MCP', sources, docIds };
}

// ── Synthesis persistence (shared by both modes) ──

const AGENT_LABEL_NAMES: Record<AgentLabel, string> = {
  WEB: 'Web',
  ACADEMIC: 'Academic',
  NEWS: 'News',
  MCP: 'MCP'
};

/**
 * Markdown body for the standalone "Research Sources" document: one table
 * per agent, each row linking to the primary source with its quality tier.
 * Citations in the report itself keep pointing at the captured documents via
 * [anchor_id] — this list is a browsable cross-reference, not a replacement.
 */
export function buildSourcesDocMarkdown(topic: string, records: SourceRecord[]): string {
  const unique = dedupeSourceRecords(records).filter(r => r.url);
  const high = unique.filter(r => r.tier === 'high').length;

  let body =
    `Consolidated source list for the research run on **${topic}**. ` +
    `${unique.length} source(s), ${high} high-authority. ` +
    `Every source below is stored as its own document in this workspace — report citations resolve to those documents, not to this list.\n`;

  const order: AgentLabel[] = ['ACADEMIC', 'WEB', 'NEWS', 'MCP'];
  for (const label of order) {
    const group = unique.filter(r => r.label === label);
    if (group.length === 0) continue;
    body += `\n## ${AGENT_LABEL_NAMES[label]} (${group.length})\n\n`;
    body += `| Source | Tier | Citations |\n|---|---|---|\n`;
    for (const r of group) {
      const link = renderSourceEntry(r);
      const tier = r.tier === 'high' ? '★ high' : 'standard';
      const cites = typeof r.citations === 'number' ? String(r.citations) : '—';
      body += `| ${link} | ${tier} | ${cites} |\n`;
    }
  }
  return body;
}

/**
 * Persist the consolidated source list as a browsable project document.
 * Saved with `enabled: false` and zero chunks: it must never enter retrieval
 * or the vector store — a table of links surfacing as a citation would be
 * garbage context. It exists purely for the user to browse in Lore.
 */
async function saveResearchSourcesDoc(
  projectId: string,
  topic: string,
  records: SourceRecord[]
): Promise<void> {
  const unique = dedupeSourceRecords(records).filter(r => r.url);
  if (unique.length === 0) return;

  const truncatedTopic = topic.length > 100 ? topic.slice(0, 97) + '…' : topic;
  const body = buildSourcesDocMarkdown(topic, records);
  const content = buildFrontmatter({
    title: `Research Sources — ${truncatedTopic}`,
    type: 'research-sources',
    wordCount: body.split(/\s+/).filter(Boolean).length,
    tags: ['research-sources']
  }) + body;

  const { id } = await saveDocument({
    title: `Research Sources — ${truncatedTopic}`,
    url: '',
    content,
    capturedAt: new Date().toISOString(),
    favicon: '',
    wordCount: body.split(/\s+/).filter(Boolean).length,
    syncedToDrive: false,
    enabled: false
  }, []);
  await linkDocumentToProject(projectId, id);
  // Intentionally NOT added to the vector store.
}

async function saveSynthesisReport(
  projectId: string,
  topic: string,
  synthesis: string,
  sources: SourceRecord[],
  mode: 'quick' | 'deep'
): Promise<void> {
  const truncatedTopic = topic.length > 120 ? topic.slice(0, 117) + '…' : topic;
  const title = `Deep Research: ${truncatedTopic}`;

  // Turn inline [anchor] citations into real links, and number the Sources list
  // to match — cited sources first (in citation order), then any uncited ones.
  const { text: linkedSynthesis, cited } = linkifyReportCitations(synthesis, sources);
  const unique = dedupeSourceRecords(sources).filter(r => r.url || r.title);
  const citedKeys = new Set(cited.map(r => r.docId || r.url));
  const ordered = [...cited, ...unique.filter(r => !citedKeys.has(r.docId || r.url))];
  const sourceLines = ordered.map((r, i) => `${i + 1}. ${renderSourceEntry(r)}`);
  const body = `${linkedSynthesis}\n\n## Sources\n${sourceLines.join('\n')}`;
  const fullSynthesisMarkdown = buildFrontmatter({
    title,
    type: 'deep-research',
    source: mode === 'deep' ? 'multi-agent-researcher' : 'deep-research-agent',
    wordCount: body.split(/\s+/).filter(Boolean).length,
    tags: [mode === 'deep' ? 'multi-agent' : 'quick-research']
  }) + body;

  const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
  const docShortId = makeDocShortId(tempId);
  const synthChunks = chunkDocument({ docShortId, content: fullSynthesisMarkdown });

  const { id: docId, chunks: savedChunks } = await saveDocument({
    title,
    url: '',
    content: fullSynthesisMarkdown,
    capturedAt: new Date().toISOString(),
    favicon: '',
    wordCount: fullSynthesisMarkdown.split(/\s+/).length,
    syncedToDrive: false
  }, synthChunks);

  await linkDocumentToProject(projectId, docId);
  await addChunksToVectorStore(projectId, savedChunks);

  // Companion artifact: the consolidated, browsable source list (Lore view).
  await saveResearchSourcesDoc(projectId, topic, sources).catch(err =>
    console.warn('Failed to save research sources doc:', err)
  );
}

// ── Main loop ──

export type SynthesisStreamFn = (sys: string, user: string) => Promise<string>;

export async function runDeepResearch(
  projectId: string,
  topic: string,
  llmChatFn: (sys: string, user: string) => Promise<string>,
  onProgress: (status: string) => void,
  signal?: AbortSignal,
  mode: 'quick' | 'deep' = 'quick',
  synthesisFn?: SynthesisStreamFn,
  evaluatorFn?: (sys: string, user: string) => Promise<string>
): Promise<{ synthesis: string, sources: string[] }> {
  activeLimits = await getResearchLimits();
  activeQuality = await getSourceQuality();
  activeAcademicDepth = await getAcademicDepth();
  const depth = await getResearchDepth();
  // /deepresearch must actually go deep. The saved depth setting defaults to
  // 'standard' (6 URLs/query, 5 queries, 2 rounds) — too thin for a deep run —
  // so floor a deep run at the 'deep' caps (10/7/4) even when the setting is
  // standard. /research (quick) still honours the setting as-is.
  if (mode === 'deep' && depth === 'standard') {
    activeLimits = RESEARCH_LIMITS.deep;
    onProgress('[PLANNING] Deep run — using deep source limits (10 URLs/query, 7 queries, 4 rounds)');
  } else if (depth !== 'standard') {
    onProgress(`[PLANNING] Research depth: ${depth}`);
  }
  if (activeQuality === 'high') onProgress('[PLANNING] Source quality: high-authority only');
  if (activeAcademicDepth === 'abstract') onProgress('[PLANNING] Academic papers: abstracts only');
  else onProgress('[PLANNING] Academic papers: full text');

  if (mode === 'deep') {
    return runDeeperResearch(projectId, topic, llmChatFn, onProgress, signal, synthesisFn, evaluatorFn);
  }

  // Reuse the plan from a checkpointed job (resume after crash/restart)
  const priorJob = await getJob().catch(() => null);
  let queries: string[];
  if (priorJob?.webQueries?.length) {
    queries = priorJob.webQueries;
    onProgress(`[PLANNING] Resuming with ${queries.length} checkpointed queries`);
  } else {
    onProgress(`[PLANNING] Generating sub-queries for topic: "${topic}"`);
    queries = await generateSearchQueries(topic, llmChatFn);
    onProgress(`[PLANNING] Generated ${queries.length} queries: ${queries.join(', ')}`);
  }
  await updateJob({ phase: 'gathering', webQueries: queries }).catch(() => {});

  const agent = await runWebAgent(projectId, queries, onProgress, signal, 'WEB');

  // Web discovery can die entirely (DuckDuckGo anti-bot blocks the keyless
  // scrape chain). Fall back to academic search — Semantic Scholar and
  // HuggingFace work without keys — before giving up.
  if (agent.docIds.length === 0) {
    onProgress('[WEB] Nothing usable from web search — falling back to academic sources…');
    try {
      const academic = await runAcademicAgent(projectId, topic, onProgress, signal, llmChatFn);
      agent.docIds.push(...academic.docIds);
      agent.sources.push(...academic.sources);
    } catch (e: any) {
      onProgress(`[ACADEMIC] Fallback failed too (${e.message})`);
    }
  }

  if (agent.docIds.length === 0) {
    const hint = 'Web search returned no results — DuckDuckGo commonly blocks keyless scraping. Add a search API key (Tavily/Brave/Serper) in Config → Research APIs for reliable discovery.';
    onProgress(`[ERROR] ${hint}`);
    throw new Error(hint);
  }

  onProgress(`[SYNTHESIZING] Scanning ${agent.docIds.length} captured documents for relevant findings...`);

  const relevantChunks = await searchSessionChunks(projectId, topic, activeLimits.quickChunks, agent.docIds);

  const contextText = buildAnchoredContext(relevantChunks, await docTitleMap(projectId)).trim();

  // Guard: never ask the LLM to synthesize from nothing (that produced the
  // "please provide the context excerpts" reply). Bail with a clear error.
  if (contextText.length < 100) {
    onProgress(`[ERROR] Extracted pages had no readable content to synthesize.`);
    throw new Error(
      `Found ${agent.sources.length} source(s) but could not extract readable text from them. ` +
      `Try a different topic or check your connection.`
    );
  }

  onProgress(`[SYNTHESIZING] Drafting final comprehensive report...`);
  await updateJob({ phase: 'synthesizing' }).catch(() => {});

  const sysPrompt = `You are a research analyst. Using ONLY the excerpts below, write a comprehensive, well-structured markdown report on: "${topic}". Group related points under headings. If the excerpts lack detail on some aspect, say so briefly. Never ask for more context — work with what is provided.\n\n${RESEARCH_CITATION_RULES}`;

  const rawSynthesis = await (synthesisFn ?? llmChatFn)(sysPrompt, `SOURCE EXCERPTS:\n\n${contextText}`);

  // Evaluator gate: audit, revise once if flagged, append collapsed audit
  const synthesis = await evaluateAndRefine(
    topic, rawSynthesis, contextText, llmChatFn, evaluatorFn ?? llmChatFn, onProgress
  );

  await saveSynthesisReport(projectId, topic, synthesis, agent.sources, 'quick');

  onProgress(`[DONE] Research complete.`);

  return { synthesis, sources: dedupeSourceRecords(agent.sources).map(renderSourceEntry) };
}

// ── Deep mode: multi-agent, cross-referenced ──

/**
 * L2: score web-reference anchor text against the topic with the offscreen
 * reranker; keep only on-topic links (drops nav/boilerplate). arXiv/DOI refs
 * skip scoring — they're inherently citable.
 */
async function scoreWebRefs(topic: string, refs: HarvestedRef[]): Promise<HarvestedRef[]> {
  if (refs.length === 0) return [];
  try {
    const res: any = await chrome.runtime.sendMessage({
      action: 'OFFSCREEN_RERANK',
      query: topic,
      passages: refs.map(r => r.anchorText || r.url)
    });
    if (res?.ok && Array.isArray(res.scores)) {
      return refs.filter((_, i) => (res.scores[i] ?? -99) > -4);
    }
  } catch { /* reranker unavailable — fall through */ }
  return refs; // no scorer → keep all (still budget-capped)
}

/**
 * L3: follow harvested references. arXiv/DOI go through the academic path
 * (full text + BibTeX); web links are scraped like any other source. Budget
 * cap prevents references from starving gap-query slots.
 */
async function followReferences(
  projectId: string,
  topic: string,
  refs: HarvestedRef[],
  budget: number,
  onProgress: (s: string) => void,
  signal?: AbortSignal
): Promise<AgentOutcome> {
  const sources: SourceRecord[] = [];
  const docIds: string[] = [];
  const { citations, web } = partitionRefs(refs);
  const scoredWeb = await scoreWebRefs(topic, web);
  const chosen = [...citations, ...scoredWeb].slice(0, budget);
  if (chosen.length === 0) return { label: 'WEB', sources, docIds };

  onProgress(`[REFS] Following ${chosen.length} reference(s) from sources (${citations.length} arXiv/DOI, ${scoredWeb.length} web)`);
  for (const ref of chosen) {
    if (signal?.aborted) throw new Error('AbortError');
    try {
      const arxivId = extractArxivId(ref.url);
      if (arxivId) {
        const fullText = await fetchArxivFullText(arxivId, signal);
        if (fullText) {
          const url = `https://arxiv.org/abs/${arxivId}`;
          const refDocId = await indexResearchDoc(projectId, `arXiv:${arxivId}`, url, fullText, 'ACADEMIC');
          docIds.push(refDocId);
          sources.push({ url, title: `arXiv:${arxivId}`, label: 'ACADEMIC', docId: refDocId, tier: 'high' });
          onProgress(`[REFS] ✓ ${url}`);
          continue;
        }
      }
      // DOI or web: scrape it (scrapeUrl handles the DOI→S2 fallback)
      const scraped = await scrapeUrl(ref.url, signal);
      if (scraped?.markdown) {
        const refDocId = await indexResearchDoc(projectId, scraped.title || ref.url, ref.url, scraped.markdown, 'WEB');
        docIds.push(refDocId);
        sources.push({ url: ref.url, title: scraped.title || ref.url, label: 'WEB', docId: refDocId, tier: sourceTier(ref.url) });
        onProgress(`[REFS] ✓ ${ref.url}`);
      }
    } catch {
      onProgress(`[REFS] ✗ ${ref.url}`);
    }
  }
  return { label: 'WEB', sources, docIds };
}

/**
 * Stage analysis between gathering rounds (Gemini-style iterative research):
 * read the evidence collected so far, note key findings, and emit new search
 * queries targeting what's still missing. Parsed defensively — an unparseable
 * response ends the iteration early rather than failing the run.
 */
async function analyzeGaps(
  topic: string,
  subQuestions: string[],
  evidence: string,
  llmChatFn: (sys: string, user: string) => Promise<string>
): Promise<{ findings: string; queries: string[] } | null> {
  const sys = `You are directing an iterative research investigation on: "${topic}".
Sub-questions under investigation:
${subQuestions.map(q => `- ${q}`).join('\n')}

Given excerpts of the evidence gathered so far, produce STRICT JSON:
{"findings": "2-4 sentence summary of what is now established", "gaps": "1-3 sentences on what is still missing", "queries": ["3-5 new web search queries targeting ONLY the gaps"]}
Return ONLY the JSON object.`;
  try {
    const res = await llmChatFn(sys, `EVIDENCE SO FAR:\n\n${evidence.slice(0, 12000)}`);
    const start = res.indexOf('{');
    const end = res.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const json = JSON.parse(res.slice(start, end + 1));
    const queries = Array.isArray(json.queries) ? json.queries.filter((q: any) => typeof q === 'string' && q.length > 3).slice(0, 5) : [];
    if (queries.length === 0) return null;
    const findings = [json.findings, json.gaps ? `Open gaps: ${json.gaps}` : ''].filter(Boolean).join(' ');
    return { findings, queries };
  } catch {
    return null;
  }
}

// ── State-of-the-art agentic improvements ────────────────────────────────────

/**
 * IMPROVEMENT 1: External Evaluator (LLM-as-Judge)
 *
 * A separate, skeptical evaluator agent reviews the synthesized report.
 * It is intentionally tuned to find flaws — not to praise.
 * Returns structured feedback appended to the report as a collapsible section.
 */
export interface EvaluationResult {
  verdict: 'PASS' | 'NEEDS_REVISION' | 'FAIL';
  score: number; // 0–10
  strengths: string[];
  weaknesses: string[];
  flaggedSections: string[];
  recommendation: string;
}

async function evaluateReport(
  topic: string,
  report: string,
  llmChatFn: (sys: string, user: string) => Promise<string>
): Promise<EvaluationResult | null> {
  const sys =
    `You are an expert research auditor and peer reviewer. Your role is to find flaws.
Do NOT be polite or skew positive. Be highly skeptical and objective.

Evaluate the research report below on: "${topic}"

Assess:
1. Claim coverage — does it address the topic fully or leave major angles untouched?
2. Evidence quality — are claims supported by citations or asserted without basis?
3. Internal consistency — do sections contradict each other?
4. Depth — does it go beyond surface-level summaries?
5. Citation density — are [anchor_id] citations present and evenly distributed?

Return STRICT JSON:
{
  "verdict": "PASS" | "NEEDS_REVISION" | "FAIL",
  "score": <0-10 integer>,
  "strengths": ["<1-sentence strength>", ...],
  "weaknesses": ["<1-sentence weakness>", ...],
  "flaggedSections": ["<section heading or quote that needs revision>", ...],
  "recommendation": "<1-2 sentence actionable summary>"
}
Return ONLY the JSON. No explanation outside it.`;

  try {
    // Use the first 8000 chars of the report to stay within context
    const reportSlice = report.slice(0, 8000);
    const res = await llmChatFn(sys, `REPORT TO EVALUATE:\n\n${reportSlice}`);
    const start = res.indexOf('{');
    const end = res.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(res.slice(start, end + 1));
    if (!parsed.verdict || typeof parsed.score !== 'number') return null;
    return parsed as EvaluationResult;
  } catch {
    return null;
  }
}

/**
 * Format evaluation result appended to the report — a quality-audit appendix.
 * Pure MARKDOWN (not <details>): the report renderer intentionally has no raw-
 * HTML plugin (reports embed scraped web text → XSS surface), so HTML tags
 * would show up literally. A small heading after a rule keeps it clearly an
 * aside rather than part of the research content.
 */
export function formatEvaluationBlock(ev: EvaluationResult, revised: boolean): string {
  const icon = ev.verdict === 'PASS' ? '✅' : ev.verdict === 'NEEDS_REVISION' ? '⚠️' : '❌';
  const lines = [
    `\n\n---\n`,
    `#### ${icon} Quality audit: ${ev.verdict} (${ev.score}/10)${revised ? ' — after one revision pass' : ''}`,
    ``,
    `> ${ev.recommendation}`,
    ``,
  ];
  if (ev.strengths.length) {
    lines.push(`**Strengths:**`);
    ev.strengths.forEach(s => lines.push(`- ${s}`));
    lines.push('');
  }
  if (ev.weaknesses.length) {
    lines.push(`**Weaknesses:**`);
    ev.weaknesses.forEach(w => lines.push(`- ⚠ ${w}`));
    lines.push('');
  }
  if (ev.flaggedSections.length) {
    lines.push(`**Sections flagged for revision:**`);
    ev.flaggedSections.forEach(f => lines.push(`- \`${f}\``));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * One bounded revision pass: feed the evaluator's weaknesses back to the
 * synthesis model together with the ORIGINAL source excerpts. Runs at most
 * once (no evaluate→revise loops), and only when the judge flags the report.
 */
async function reviseSynthesis(
  topic: string,
  synthesis: string,
  evaluation: EvaluationResult,
  sourceContext: string,
  llmChatFn: LlmChatFn
): Promise<string> {
  const sys =
    `You are revising a research report on: "${topic}" after a quality audit flagged problems.
Auditor's findings:
${evaluation.weaknesses.map(w => `- ${w}`).join('\n')}
${evaluation.flaggedSections.length ? `Flagged sections: ${evaluation.flaggedSections.join('; ')}` : ''}

Rewrite the report to address these findings using ONLY the source excerpts provided.
- If the sources genuinely cannot answer the topic, say so prominently in the first paragraph and keep the report short — do NOT pad with tangentially related material.
- Preserve correct [anchor_id] citations; never fabricate anchors.
- Cut content the auditor called irrelevant rather than defending it.

${RESEARCH_CITATION_RULES}`;
  const user = `ORIGINAL REPORT:\n\n${synthesis.slice(0, 12_000)}\n\nSOURCE EXCERPTS:\n\n${sourceContext.slice(0, 30_000)}`;
  const revised = await llmChatFn(sys, user);
  return revised.trim().length > 200 ? revised : synthesis;
}

/**
 * Evaluate → optionally revise once → append the collapsed audit block.
 * Returns the final report text. Used by both quick and deep modes.
 */
async function evaluateAndRefine(
  topic: string,
  synthesis: string,
  sourceContext: string,
  llmChatFn: LlmChatFn,
  evaluatorFn: LlmChatFn,
  onProgress: (s: string) => void
): Promise<string> {
  synthesis = stripModelBibliography(synthesis);
  onProgress(`[EVALUATING] Running quality evaluation on report…`);
  const first = await evaluateReport(topic, synthesis, evaluatorFn).catch(() => null);
  if (!first) return synthesis;

  const label = (ev: EvaluationResult) =>
    ev.verdict === 'PASS' ? '✅ PASS' : ev.verdict === 'NEEDS_REVISION' ? '⚠️ NEEDS REVISION' : '❌ FAIL';
  onProgress(`[EVALUATING] Verdict: ${label(first)} (${first.score}/10) — ${first.recommendation}`);

  if (first.verdict === 'PASS' || first.score >= 7) {
    return synthesis + formatEvaluationBlock(first, false);
  }

  // Flagged: one revision pass, then re-audit so the shown verdict is honest.
  onProgress(`[EVALUATING] Revising report to address auditor findings…`);
  const revised = stripModelBibliography(
    await reviseSynthesis(topic, synthesis, first, sourceContext, llmChatFn).catch(() => synthesis)
  );
  if (revised === synthesis) {
    return synthesis + formatEvaluationBlock(first, false);
  }
  const second = await evaluateReport(topic, revised, evaluatorFn).catch(() => null);
  if (second) {
    onProgress(`[EVALUATING] Post-revision verdict: ${label(second)} (${second.score}/10)`);
    return revised + formatEvaluationBlock(second, true);
  }
  return revised + formatEvaluationBlock(first, true);
}

/**
 * IMPROVEMENT 2: Context Reset / Structured Stage Handoff
 *
 * Instead of feeding raw evidence chunks into the next stage's gap analysis,
 * compress prior stage findings into a structured handoff state.
 * This prevents coherence drift in long multi-stage runs.
 */
async function buildStageHandoff(
  stage: number,
  topic: string,
  subQuestions: string[],
  stageBrief: string,
  llmChatFn: (sys: string, user: string) => Promise<string>
): Promise<string> {
  const sys =
    `You are a research coordinator managing a multi-stage investigation of: "${topic}".
Sub-questions: ${subQuestions.map((q, i) => `${i + 1}. ${q}`).join(' | ')}
Stage ${stage} has just completed. Produce a concise HANDOFF STATE for the next stage.

Format (use these exact headings):
## Established Facts
(bullet list — what is now confirmed with citations)

## Open Gaps
(bullet list — what was NOT answered; be specific)

## Contradictions Found
(bullet list — conflicting claims between sources, or "None")

## Recommended Focus for Next Stage
(1-2 sentences — what the next stage should prioritize)

Keep it under 400 words. Preserve [anchor_id] citations for established facts.`;

  try {
    const handoff = await llmChatFn(sys, `STAGE ${stage} BRIEF:\n\n${stageBrief.slice(0, 6000)}`);
    return handoff;
  } catch {
    // Fallback: use first 1000 chars of brief as handoff
    return stageBrief.slice(0, 1000);
  }
}

/**
 * IMPROVEMENT 3: Spec-Driven Planning
 *
 * Before gathering begins, generate a research specification:
 * scope, exclusions, success criteria, sub-question priorities.
 * This spec is prepended to every stage brief prompt so the LLM
 * stays aligned with the original intent throughout long runs.
 */
async function generateResearchSpec(
  topic: string,
  subQuestions: string[],
  llmChatFn: (sys: string, user: string) => Promise<string>
): Promise<string> {
  const sys =
    `You are a research strategist. Before any gathering begins, produce a RESEARCH SPECIFICATION for:
"${topic}"

Sub-questions identified:
${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Produce STRICT JSON:
{
  "scope": "<1-2 sentences: what IS in scope>",
  "exclusions": ["<topic or angle explicitly out of scope>", ...],
  "successCriteria": ["<what a good answer to each sub-question looks like>", ...],
  "priorityOrder": [<indices 0-based of sub-questions from most to least critical>],
  "keyTerms": ["<important terms/synonyms to search for>", ...]
}
Return ONLY the JSON.`;

  try {
    const res = await llmChatFn(sys,
      `Topic: ${topic}\nSub-questions:\n${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    );
    const start = res.indexOf('{');
    const end = res.lastIndexOf('}');
    if (start === -1 || end === -1) return '';
    // Validate parseable
    JSON.parse(res.slice(start, end + 1));
    return res.slice(start, end + 1);
  } catch {
    return '';
  }
}

/**
 * Format spec as a readable preamble injected into stage brief prompts.
 */
function formatSpecPreamble(specJson: string): string {
  try {
    const spec = JSON.parse(specJson);
    const lines = [`RESEARCH SPECIFICATION:`];
    if (spec.scope) lines.push(`Scope: ${spec.scope}`);
    if (spec.exclusions?.length) lines.push(`Exclusions: ${spec.exclusions.join(', ')}`);
    if (spec.successCriteria?.length) {
      lines.push(`Success criteria:`);
      spec.successCriteria.forEach((c: string) => lines.push(`  - ${c}`));
    }
    if (spec.keyTerms?.length) lines.push(`Key terms: ${spec.keyTerms.join(', ')}`);
    return lines.join('\n') + '\n\n';
  } catch {
    return '';
  }
}

// ── Staged synthesis helpers ──────────────────────────────────────────────────

/**
 * Detect garbled PDF extraction: letter-spaced words, high single-char ratio,
 * lots of bare page headers. Returns true when at least 2 signals fire.
 */
function isGarbledPdf(text: string): boolean {
  let signals = 0;
  // Signal 1: letter-spaced words — "T a b l e" pattern
  const letterSpaced = (text.match(/\b[A-Z] [A-Z] [A-Z]\b/g) || []).length;
  if (letterSpaced >= 3) signals++;
  // Signal 2: high ratio of single-char tokens (broken column extraction)
  const tokens = text.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length > 50) {
    const singleChar = tokens.filter(t => t.length === 1 && /[a-zA-Z]/.test(t)).length;
    if (singleChar / tokens.length > 0.12) signals++;
  }
  // Signal 3: many short page sections (OCR-style page-by-page output with thin text)
  const pageMatches = text.match(/## Page \d+/g) || [];
  if (pageMatches.length >= 4) {
    const avgCharsPerPage = text.length / pageMatches.length;
    if (avgCharsPerPage < 400) signals++;
  }
  // Signal 4: repeated header/footer bleed-in (journal name or author list
  // appearing more than 3× — typical of running headers in two-column papers)
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10 && l.length < 80);
  const lineCounts = new Map<string, number>();
  for (const l of lines) lineCounts.set(l, (lineCounts.get(l) || 0) + 1);
  if ([...lineCounts.values()].some(n => n >= 4)) signals++;

  return signals >= 2;
}

/**
 * LLM-powered cleanup of garbled PDF text. Returns cleaned markdown only.
 * The caller is responsible for appending the raw text as a collapsible block.
 */
async function cleanPdfText(
  raw: string,
  llmChatFn: (sys: string, user: string) => Promise<string>
): Promise<string> {
  const sys =
    `You are a document editor cleaning up academic paper text extracted from a PDF by pdf.js.
The extraction is often garbled: broken words like "T a b l e" instead of "Table", letter-spaced
headings, scrambled two-column layout, running page headers/footers bleeding mid-paragraph,
and algorithm pseudocode turned into symbol soup.

Your job:
1. Fix broken/letter-spaced words (reconstruct them).
2. Remove page headers, footers, and author affiliations that bleed between paragraphs.
3. Reconstruct tables as proper markdown tables where recognisable.
4. Normalise math notation to readable inline text (e.g. "α" → "α", "∑" → "sum").
5. Preserve ALL original content — do not summarise or omit anything.
6. Output ONLY the cleaned paper text in markdown, nothing else.`;

  // Feed at most 14k chars to avoid blowing the model context — long papers
  // should be cleaned in their most information-dense portion (the body).
  const excerpt = raw.slice(0, 14_000);
  try {
    const cleaned = await llmChatFn(sys, excerpt);
    // Sanity check: if the model returned something very short it probably failed
    return cleaned.length > 200 ? cleaned : raw;
  } catch {
    return raw;
  }
}

/**
 * Wrap a cleaned PDF body and its raw extraction into a single document.
 * Only the clean section above the separator is chunked (the raw block is
 * treated as noise by isNoiseParagraph due to the page-header pattern).
 */
export function buildCleanedPdfDoc(cleanText: string, rawText: string): string {
  // Markdown heading, not <details> — the document renderer has no raw-HTML
  // plugin, so tags would render literally. A rule + heading keeps the raw
  // extraction clearly separated as a reference appendix.
  return (
    cleanText.trim() +
    `\n\n---\n\n` +
    `## Raw PDF extraction (reference only — not indexed)\n\n` +
    rawText.trim()
  );
}

type LlmChatFn = (sys: string, user: string) => Promise<string>;

/**
 * Synthesize a ~1500-word brief from the chunks collected in one stage.
 * Uses all chunks from stageDocIds that fit within the model context budget,
 * round-robin balanced across source types.
 */
async function synthesizeStageBrief(
  stage: number,
  totalStages: number,
  topic: string,
  subQuestions: string[],
  stageDocIds: string[],
  projectId: string,
  labelByDoc: Map<string, AgentLabel>,
  llmChatFn: LlmChatFn,
  specPreamble = '',
  handoffContext = ''
): Promise<string> {
  if (stageDocIds.length === 0) return '';

  // Retrieve chunks only from this stage's new docs
  const rawChunks = await searchSessionChunks(projectId, topic, 30, stageDocIds);
  // Also fetch chunks for each sub-question to get better coverage
  const extra: any[] = [];
  for (const q of subQuestions) {
    const hits = await searchSessionChunks(projectId, q, 15, stageDocIds);
    hits.forEach(c => extra.push(c));
  }
  // Merge + deduplicate by chunk id
  const chunkMap = new Map<string, any>();
  [...rawChunks, ...extra].forEach(c => chunkMap.set(c.id, c));

  // Balance across source types and pack up to context budget
  const byLabel = new Map<string, any[]>();
  for (const c of chunkMap.values()) {
    const l = labelByDoc.get(c.docId) || 'WEB';
    if (!byLabel.has(l)) byLabel.set(l, []);
    byLabel.get(l)!.push(c);
  }

  const charBudget = await getSynthesisCharBudget();
  const selected: any[] = [];
  let usedChars = 0;
  const labelOrder = [...byLabel.keys()];
  packing: while (true) {
    let added = false;
    for (const l of labelOrder) {
      const g = byLabel.get(l)!;
      if (g.length > 0) {
        const c = g.shift();
        if (usedChars + c.text.length > charBudget && selected.length > 0) break packing;
        selected.push(c);
        usedChars += c.text.length;
        added = true;
      }
    }
    if (!added) break;
  }

  if (selected.length === 0) return '';

  const anchoredChunks = selected.map(c => ({
    ...c,
    heading: `[${labelByDoc.get(c.docId) || 'WEB'}] ${c.heading || ''}`.trim()
  }));
  const contextText = buildAnchoredContext(anchoredChunks, await docTitleMap(projectId)).trim();

  const sys =
    `You are a research analyst writing Stage ${stage} of ${totalStages} in a staged investigation of: "${topic}".
${specPreamble ? `\n${specPreamble}` : ''}
Using ONLY the source excerpts below, write a comprehensive research brief (aim for ~1500 words).
${handoffContext ? `\nCONTEXT FROM PRIOR STAGES:\n${handoffContext}\n` : ''}
Sub-questions to address:
${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Requirements:
- Write in flowing academic prose (no bullet-point summaries).
- Cite EVERY factual claim inline with its anchor id: "...text [anchor_id]."
- Where multiple sources agree, cite all of them together: [id1][id2].
- Where sources conflict, state the conflict explicitly and cite both sides.
- End with a section "## Open Questions from Stage ${stage}" listing 3-5 bullet gaps this stage did NOT answer.

${RESEARCH_CITATION_RULES}`;

  return llmChatFn(sys, `SOURCE EXCERPTS — STAGE ${stage}:\n\n${contextText}`);
}

/**
 * Final synthesis: merge all stage briefs into a single comprehensive
 * academic-style paper. The briefs already contain [anchor_id] citations
 * which must be preserved verbatim in the output.
 */
async function synthesizeFinalPaper(
  topic: string,
  subQuestions: string[],
  stageBriefs: string[],
  llmChatFn: LlmChatFn,
  synthesisFn?: SynthesisStreamFn
): Promise<string> {
  const briefsBlock = stageBriefs
    .map((b, i) => `## Stage ${i + 1} Research Brief\n\n${b}`)
    .join('\n\n---\n\n');

  const sys =
    `You are a research editor. You have received ${stageBriefs.length} research briefs from a staged investigation of: "${topic}".
Each brief contains inline [anchor_id] citations — YOU MUST PRESERVE EVERY ONE exactly as written.

Your task: synthesize all briefs into a single comprehensive academic paper with these sections:

1. **Abstract** (~200 words summarising the entire investigation)
2. **Introduction** (context, motivation, scope)
3. One section per sub-question:
${subQuestions.map((q, i) => `   ${i + 1}. ${q}`).join('\n')}
4. **Discussion** (compare/contrast findings across stages; highlight consensus and contradictions)
5. **Conclusion**
6. **Open Questions & Future Work** (synthesise the gaps listed at the end of each stage brief)

Strict rules:
- Preserve ALL [anchor_id] citations from the briefs — do not drop, alter, or invent any.
- Integrate duplicate coverage gracefully: if two stages discuss the same finding, merge them and carry citations from both.
- Flag conflicts explicitly: "Stage 2 found X [id] while Stage 4 found Y [id]."
- Do not add factual claims absent from the briefs.
- Write in formal academic English.

${RESEARCH_CITATION_RULES}`;

  const userMsg = `RESEARCH BRIEFS:\n\n${briefsBlock}`;
  return (synthesisFn ?? llmChatFn)(sys, userMsg);
}

async function runDeeperResearch(
  projectId: string,
  topic: string,
  llmChatFn: (sys: string, user: string) => Promise<string>,
  onProgress: (status: string) => void,
  signal?: AbortSignal,
  synthesisFn?: SynthesisStreamFn,
  evaluatorFn?: (sys: string, user: string) => Promise<string>
): Promise<{ synthesis: string, sources: string[] }> {

  // ── Phase 1: strategic planning ──────────────────────────────────────────
  // Reuse a checkpointed plan on resume so we don't re-plan after a crash.
  const priorJob = await getJob().catch(() => null);
  let subQuestions: string[];
  let webQueries: string[];
  if (priorJob?.subQuestions?.length && priorJob?.webQueries?.length) {
    subQuestions = priorJob.subQuestions;
    webQueries = priorJob.webQueries;
    onProgress(`[PLANNING] Resuming checkpointed plan (${subQuestions.length} sub-questions)`);
  } else {
    onProgress(`[PLANNING] Decomposing "${topic}" into research sub-questions…`);
    subQuestions = await generateSubQuestions(topic, llmChatFn);
    onProgress(`[PLANNING] ${subQuestions.length} sub-questions: ${subQuestions.join(' | ')}`);
    webQueries = await generateSearchQueries(topic, llmChatFn);
  }

  // ── Spec-Driven Planning (Improvement 3) ─────────────────────────────────
  // Generate a research specification before any gathering begins.
  // The spec anchors all subsequent stage briefs to the original intent.
  let researchSpec = '';
  if (!priorJob?.subQuestions?.length) {
    onProgress(`[PLANNING] Generating research specification…`);
    researchSpec = await generateResearchSpec(topic, subQuestions, llmChatFn).catch(() => '');
    if (researchSpec) {
      onProgress(`[PLANNING] ✓ Research spec locked in — scope and success criteria defined`);
    }
  }

  await updateJob({ phase: 'gathering', subQuestions, webQueries }).catch(() => {});

  // ── Phase 2: staged gather → brief → checkpoint loop ────────────────────
  const rounds = Math.max(1, activeLimits.rounds);

  // Resume state: already-completed stages survive a worker restart
  const stageBriefs: string[] = priorJob?.stageBriefs ?? [];
  const resumeFromStage = (priorJob?.currentStage ?? 0) + 1; // 1-based; 1 = start fresh

  const agents: AgentOutcome[] = [];
  // labelByDoc persists across stages so later briefs can tag source types
  const labelByDoc = new Map<string, AgentLabel>();

  let stageQueries = webQueries.slice(0, activeLimits.webQueries);

  const specPreamble = formatSpecPreamble(researchSpec);

  // handoffContext accumulates structured stage summaries (Improvement 2: Context Reset)
  let handoffContext = '';

  for (let stage = 1; stage <= rounds; stage++) {
    if (signal?.aborted) throw new Error('AbortError');

    // ── Resume: skip stages already completed before a crash ──────────────
    if (stage < resumeFromStage) {
      onProgress(`[STAGE ${stage}/${rounds}] Skipping (already completed before restart)`);
      continue;
    }

    onProgress(`[STAGE ${stage}/${rounds}] Gathering: ${stageQueries.length} quer${stageQueries.length === 1 ? 'y' : 'ies'}…`);

    // ── Gather ────────────────────────────────────────────────────────────
    const stageJobs: Promise<AgentOutcome>[] = [
      runWebAgent(projectId, stageQueries, onProgress, signal, 'WEB')
    ];
    // Academic / news / MCP run once (stage 1 only) — re-querying burns rate limits
    if (stage === 1) {
      stageJobs.push(
        runMcpAgent(projectId, topic, onProgress, signal),
        runNewsAgent(projectId, topic, onProgress, signal)
      );
      // Academic papers only for genuinely scholarly topics — on practical or
      // consumer topics they return off-topic CS papers (often garbled PDFs).
      if (isAcademicQuery(topic)) {
        stageJobs.push(runAcademicAgent(projectId, topic, onProgress, signal, llmChatFn));
      } else {
        onProgress('[ACADEMIC] Skipped — topic is practical, not scholarly (web/news only)');
      }
    }

    const outcomes = await Promise.allSettled(stageJobs);
    if (signal?.aborted) throw new Error('AbortError');

    const stageDocIds: string[] = [];   // NEW docs from THIS stage only
    for (const o of outcomes) {
      if (o.status === 'fulfilled') {
        if (o.value.label === 'MCP' && o.value.docIds.length === 0) continue;
        agents.push(o.value);
        stageDocIds.push(...o.value.docIds);
        o.value.docIds.forEach(d => labelByDoc.set(d, o.value.label));
      } else {
        onProgress(`[AGENTS] An agent failed: ${o.reason}`);
      }
    }

    // Link-following: chase references found inside the stage's sources
    if (stageDocIds.length > 0) {
      const evidenceChunks = await searchSessionChunks(projectId, topic, 20, stageDocIds);
      const seenUrls = new Set((await listPages().catch(() => [])).map(p => p.url));
      const refs = harvestReferences(evidenceChunks.map(c => c.text), { seenUrls, isJunk: isJunkUrl });
      if (refs.length > 0) {
        const refBudget = Math.max(2, Math.floor(activeLimits.urlsPerQuery / 3));
        const refOutcome = await followReferences(projectId, topic, refs, refBudget, onProgress, signal);
        if (refOutcome.docIds.length > 0) {
          agents.push(refOutcome);
          stageDocIds.push(...refOutcome.docIds);
          refOutcome.docIds.forEach(d => labelByDoc.set(d, refOutcome.label));
        }
      }
    }

    if (signal?.aborted) throw new Error('AbortError');

    // ── Per-stage synthesis → checkpoint ─────────────────────────────────
    const uniqueStageDocIds = Array.from(new Set(stageDocIds));
    if (uniqueStageDocIds.length > 0) {
      onProgress(`[STAGE ${stage}/${rounds}] Synthesizing brief from ${uniqueStageDocIds.length} source(s)…`);
      await updateJob({ phase: 'synthesizing' }).catch(() => {});

      const brief = await synthesizeStageBrief(
        stage, rounds, topic, subQuestions,
        uniqueStageDocIds, projectId, labelByDoc, llmChatFn,
        specPreamble,    // Improvement 3: spec-driven
        handoffContext   // Improvement 2: context reset handoff
      ).catch(err => {
        onProgress(`[STAGE ${stage}/${rounds}] Brief synthesis failed: ${err?.message || err}`);
        return '';
      });

      if (brief) {
        const wordCount = brief.split(/\s+/).filter(Boolean).length;
        onProgress(`[STAGE ${stage}/${rounds}] ✓ Brief: ${wordCount} words from ${uniqueStageDocIds.length} sources`);

        // ── Context Reset (Improvement 2): compress stage findings into handoff ──
        if (stage < rounds) {
          onProgress(`[STAGE ${stage}/${rounds}] Building context handoff for next stage…`);
          handoffContext = await buildStageHandoff(stage, topic, subQuestions, brief, llmChatFn).catch(() => '');
        }

        // Save the stage brief as a visible project document
        await indexResearchDoc(
          projectId,
          `Stage ${stage} of ${rounds} — ${topic.length > 60 ? topic.slice(0, 57) + '…' : topic}`,
          '',
          brief,
          'WEB'  // neutral label so it doesn't inflate ACADEMIC count
        ).catch(() => {}); // non-fatal — brief is still in memory

        stageBriefs[stage - 1] = brief;
        // Checkpoint: survive a worker restart
        await updateJob({
          phase: 'gathering',
          stageBriefs,
          currentStage: stage
        }).catch(() => {});
      } else {
        onProgress(`[STAGE ${stage}/${rounds}] ⚠ No brief generated — moving on`);
      }
    } else {
      onProgress(`[STAGE ${stage}/${rounds}] No new sources — skipping brief`);
    }

    if (stage === rounds) break;

    // ── Gap analysis: what to search next ────────────────────────────────
    const docsSoFar = agents.flatMap(a => a.docIds);
    if (docsSoFar.length > 0) {
      const evidenceForGap = await searchSessionChunks(projectId, topic, 20, docsSoFar);
      const evidence = evidenceForGap.map(c => c.text).join('\n\n');
      const analysis = await analyzeGaps(topic, subQuestions, evidence, llmChatFn).catch(() => null);
      if (analysis) {
        stageQueries = analysis.queries;
        onProgress(`[STAGE ${stage}/${rounds}] Next stage queries: ${analysis.queries.join(' | ')}`);
      } else {
        // One unparseable planning call must not collapse a multi-stage run
        // into stage 1: fall back to the sub-questions as the next stage's
        // queries — they were the plan the user approved.
        stageQueries = subQuestions.slice(0, activeLimits.webQueries);
        onProgress(`[STAGE ${stage}/${rounds}] Gap analysis inconclusive — continuing with sub-questions as queries`);
      }
      await updateJob({ webQueries: stageQueries }).catch(() => {});
    }
  }

  // ── Phase 3: final paper synthesis ───────────────────────────────────────
  const allDocIds = agents.flatMap(a => a.docIds);
  const allSources = dedupeSourceRecords(agents.flatMap(a => a.sources));
  const completedBriefs = stageBriefs.filter(Boolean);

  if (completedBriefs.length === 0 && allDocIds.length === 0) {
    throw new Error('No agent could gather any sources.');
  }

  const mixSummary = agents.reduce((acc: Record<string, number>, a) => {
    acc[a.label] = (acc[a.label] || 0) + a.sources.length;
    return acc;
  }, {});
  const mixStr = Object.entries(mixSummary).map(([l, n]) => `${l} ${n}`).join(' · ');
  onProgress(`[AGENTS] Source mix — ${mixStr}`);

  await updateJob({ phase: 'synthesizing' }).catch(() => {});

  let synthesis: string;
  // Source context handed to the evaluator's revision pass — briefs on the
  // staged path, the packed excerpts on the fallback path.
  let revisionContext = '';

  if (completedBriefs.length > 0) {
    // Staged path: merge all stage briefs into one comprehensive paper
    onProgress(`[SYNTHESIZING] Merging ${completedBriefs.length} stage brief(s) into final paper…`);
    synthesis = await synthesizeFinalPaper(
      topic, subQuestions, completedBriefs, llmChatFn, synthesisFn
    );
  } else {
    // Fallback: no briefs produced (all syntheses failed) — do classic single-pass
    onProgress(`[SYNTHESIZING] No stage briefs available — falling back to direct synthesis…`);
    const chunkSet = new Map<string, any>();
    const uniqueDocIds = Array.from(new Set(allDocIds));
    for (const q of [topic, ...subQuestions]) {
      if (signal?.aborted) throw new Error('AbortError');
      const chunks = await searchSessionChunks(projectId, q, activeLimits.chunksPerAngle, uniqueDocIds);
      chunks.forEach(c => chunkSet.set(c.id, c));
    }
    const charBudget = await getSynthesisCharBudget();
    const byLabel = new Map<string, any[]>();
    for (const c of chunkSet.values()) {
      const l = labelByDoc.get(c.docId) || 'WEB';
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l)!.push(c);
    }
    const relevantChunks: any[] = [];
    let usedChars = 0;
    const labelOrder = [...byLabel.keys()];
    packing: while (true) {
      let added = false;
      for (const l of labelOrder) {
        const g = byLabel.get(l)!;
        if (g.length > 0) {
          const c = g.shift();
          if (usedChars + c.text.length > charBudget && relevantChunks.length > 0) break packing;
          relevantChunks.push(c);
          usedChars += c.text.length;
          added = true;
        }
      }
      if (!added) break;
    }
    const anchoredChunks = relevantChunks.map(c => ({
      ...c,
      heading: `[${labelByDoc.get(c.docId) || 'WEB'}] ${c.heading || ''}`.trim()
    }));
    const contextText = buildAnchoredContext(anchoredChunks, await docTitleMap(projectId)).trim();
    if (contextText.length < 100) {
      throw new Error(`Agents found ${allSources.length} source(s) but could not extract readable text.`);
    }
    const fallbackSys = `You are a senior research analyst. Using ONLY the excerpts below, write a comprehensive markdown report on: "${topic}".\n\nSub-questions:\n${subQuestions.map(q => `- ${q}`).join('\n')}\n\n${RESEARCH_CITATION_RULES}`;
    synthesis = await (synthesisFn ?? llmChatFn)(fallbackSys, `SOURCE EXCERPTS:\n\n${contextText}`);
    revisionContext = contextText;
  }

  // Prepend source-mix banner
  synthesis = `> **Source mix:** ${mixStr}\n\n${synthesis}`;

  // Evaluator gate: audit, revise once if flagged (stage briefs act as the
  // source context for the staged path; packed excerpts on the fallback path)
  if (completedBriefs.length > 0) {
    revisionContext = completedBriefs
      .map((b, i) => `## Stage ${i + 1} Research Brief\n\n${b}`)
      .join('\n\n---\n\n');
  }
  synthesis = await evaluateAndRefine(
    topic, synthesis, revisionContext, llmChatFn, evaluatorFn ?? llmChatFn, onProgress
  );

  await saveSynthesisReport(projectId, topic, synthesis, allSources, 'deep');
  onProgress(`[DONE] ${completedBriefs.length} stage briefs → final paper — ${allSources.length} sources total.`);

  return { synthesis, sources: allSources.map(renderSourceEntry) };
}
