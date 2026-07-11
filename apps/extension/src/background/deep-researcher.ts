import { saveDocument, linkDocumentToProject } from '../lib/db';
import { chunkDocument, makeDocShortId } from '../lib/chunker';
import { buildFrontmatter } from '../lib/frontmatter';
import { addChunksToVectorStore, searchSessionChunks } from '../lib/vector-store';
import { getJob, updateJob, getPage, savePage, listPages } from '../lib/research-store';
import { pdfUrlToBody } from '../lib/pdf-parser';
import { checkContentQuality, extractDoi } from '../lib/quality-gate';
import { getResearchLimits, getResearchDepth, getSynthesisCharBudget, getSourceQuality, RESEARCH_LIMITS, ResearchLimits, SourceQuality } from '../lib/research-limits';
import { generateBibtex } from '../lib/bibtex';
import { harvestReferences, partitionRefs, HarvestedRef } from '../lib/reference-harvest';
import { getMcpServers, McpConnection, isSearchLikeTool, topicArgFor } from '../lib/mcp-client';
import { searchWithProviders } from '../lib/search-providers';
import { rankPapers } from '../lib/paper-rank';
import { semaphore } from '../lib/semaphore';

// F9: cap concurrent indexing so the offscreen document (WebGPU embeddings)
// doesn't starve sidepanel search queries. Scraping stays parallel across
// agents (I/O bound); only the saveDocument/embedding phase is serialized.
const indexingSem = semaphore(2);

// Active tier for the current run — set at run start from Settings. A single
// research job runs at a time (enforced by the job store), so module state
// is safe here.
let activeLimits: ResearchLimits = RESEARCH_LIMITS.standard;
let activeQuality: SourceQuality = 'all';

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

const RESEARCH_CITATION_RULES =
  `CITATION RULES (mandatory — this report is graded on source-grounding, not confidence claims):\n` +
  `1. Every factual claim MUST end with the citation anchor of the excerpt it came from, e.g. "...grew 40% in 2023 [d3ab01.s1.p2]."\n` +
  `2. Citation format: [anchor_id] taken verbatim from the <c>anchor_id</c> tag preceding the excerpt you used. ONE anchor per bracket. For multiple corroborating sources write [anchor1][anchor2] — never comma-separate inside one bracket.\n` +
  `3. Never fabricate an anchor ID or cite one that wasn't given to you.\n` +
  `4. When multiple sources support the same claim, cite all of them — that IS the credibility signal. Do NOT use vague labels like "[High confidence]" or "[Low confidence]"; showing 2-3 independent anchors on a claim is more useful than a confidence tag.\n` +
  `5. If the excerpts don't cover something, say so explicitly instead of citing something unrelated.\n`;

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
      if (decoded.startsWith('http') && !BLOCKED_DOMAINS.test(decoded)) urls.add(decoded);
    } catch { /* skip malformed */ }
  }

  // 2) Plain links (Jina reader markdown of the results page)
  if (urls.size === 0) {
    const linkRegex = /https?:\/\/[^\s)"'\]<>]+/g;
    while ((m = linkRegex.exec(text)) !== null && urls.size < 12) {
      const u = m[0].replace(/[.,;]+$/, '');
      if (!BLOCKED_DOMAINS.test(u) && !/jina\.ai/.test(u)) urls.add(u);
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
async function performWebSearch(query: string, signal?: AbortSignal): Promise<string[]> {
  // User-linked search APIs (Tavily/Brave/Serper) take priority — cleaner
  // results and no anti-bot roulette. No keys configured → scrape chain.
  try {
    const providerUrls = await searchWithProviders(query, activeLimits.urlsPerQuery * 2, signal);
    if (providerUrls.length > 0) {
      const sortedP = providerUrls.sort((a, b) => {
        const aHigh = HIGH_QUALITY_DOMAINS.test(a) ? 0 : 1;
        const bHigh = HIGH_QUALITY_DOMAINS.test(b) ? 0 : 1;
        return aHigh - bHigh;
      });
      return sortedP.slice(0, activeLimits.urlsPerQuery);
    }
  } catch (e) {
    console.warn('Search providers failed, falling back to scrape chain', e);
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

  return sorted.slice(0, activeLimits.urlsPerQuery);
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
async function scrapeUrl(url: string, signal?: AbortSignal): Promise<ParsedPage | null> {
  let parsed: ParsedPage | null = null;

  // 1) Jina Reader
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

// ── LLM planning ──

export async function generateSearchQueries(topic: string, llmChatFn: (sys: string, user: string) => Promise<string>): Promise<string[]> {
  const sysPrompt = `You are an expert research planner specializing in finding authoritative, high-quality sources. Given a topic, generate 7 precise web search queries that would surface:
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
  const sysPrompt = `You are a research strategist. Decompose the given topic into 5-7 distinct research sub-questions that together give comprehensive coverage: core mechanisms, current state of the art, applications, limitations, open debates, and recent developments. Return ONLY a JSON array of strings, nothing else.`;
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
  const rawChunks = chunkDocument({ docShortId, content: fullMarkdown });

  // F9: gate the embedding-heavy saveDocument through the semaphore so
  // parallel agents don't stack up on the offscreen doc.
  const { id: docId, chunks: savedChunks } = await indexingSem(() => saveDocument({
    title: title || 'Untitled',
    url: url || '',
    content: fullMarkdown,
    capturedAt: new Date().toISOString(),
    favicon: '',
    wordCount,
    syncedToDrive: false,
    enabled: true,
    bibtex
  }, rawChunks));

  await linkDocumentToProject(projectId, docId);
  await addChunksToVectorStore(projectId, savedChunks);
  return docId;
}

// ── Research agents (deep mode) ──

type AgentLabel = 'WEB' | 'ACADEMIC' | 'NEWS' | 'MCP';

/**
 * URLs that can never be research sources: schema/DTD references, asset
 * files, tracker endpoints. These leak in from link extraction on scraped
 * pages (e.g. http://www.w3.org/TR/html4/loose.dtd).
 */
function isJunkUrl(url: string): boolean {
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
  sources: string[];
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
  const urlList = [...new Set(urls)].filter(u => !isJunkUrl(u));
  const sources: string[] = [];
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
        docIds.push(await indexResearchDoc(projectId, title || url, url, markdown, label));
        sources.push(sourceEntry(title, url));
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
    found.forEach(u => allUrls.add(u));
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
    res = await fetch(url, { signal, headers });
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
    { signal, headers: { 'Accept': 'application/json' } }
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
  const res = await fetch(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(query)}`, { signal });
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
async function fetchArxivFullText(arxivId: string, signal?: AbortSignal): Promise<string | null> {
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  try {
    if (signal?.aborted) throw new Error('AbortError');
    try {
      // Offscreen fetches + parses (size-scaled timeout, no base64 transfer)
      const body = await pdfUrlToBody(pdfUrl);
      const textOnly = body.replace(/## Page \d+\n\n\*\(no extractable text\)\*/g, '').trim();
      return textOnly.length >= 100 ? body : null;
    } finally {
      /* nothing to clean up */
    }
  } catch {
    return null;
  }
}

/** Academic agent: paper abstracts from Semantic Scholar + HuggingFace. */
async function runAcademicAgent(
  projectId: string,
  topic: string,
  onProgress: (s: string) => void,
  signal?: AbortSignal
): Promise<AgentOutcome> {
  const papers: AcademicPaper[] = [];

  // Resume: papers cached before a crash count even if the APIs are
  // rate-limiting us now.
  const cachedSources: string[] = [];
  const cachedDocIds: string[] = [];
  const cachedTitles = new Set<string>();
  try {
    const cachedPages = (await listPages()).filter(p => p.label === 'ACADEMIC');
    for (const page of cachedPages) {
      cachedDocIds.push(await indexResearchDoc(projectId, page.title, page.url, page.markdown, 'ACADEMIC'));
      if (page.url.startsWith('http') && !isJunkUrl(page.url)) cachedSources.push(sourceEntry(page.title, page.url));
      cachedTitles.add(page.title.toLowerCase().trim());
    }
    if (cachedPages.length > 0) onProgress(`[ACADEMIC] Restored ${cachedPages.length} cached paper(s)`);
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

  const sources: string[] = [...cachedSources];
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
  const academicCap = activeLimits.s2Limit + activeLimits.hfLimit;
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

  // Fetch full-text PDFs in parallel batches of 4.
  const BATCH = 4;
  for (let i = 0; i < deduped.length; i += BATCH) {
    if (signal?.aborted) throw new Error('AbortError');
    await yieldToEventLoop();
    const batch = deduped.slice(i, i + BATCH);
    await Promise.all(batch.map(async (p) => {
      const key = p.title.toLowerCase().trim();
      const headerLine = `# ${p.title}\n\n**Authors:** ${p.authors || 'Unknown'}${p.year ? ` (${p.year})` : ''}${typeof p.citations === 'number' ? `\n**Citations:** ${p.citations}` : ''}${p.venue ? `\n**Venue:** ${p.venue}` : ''}`;
      const abstractSection = `## Abstract\n\n${p.abstract}`;
      let md = `${headerLine}\n\n${abstractSection}`;

      const arxivId = extractArxivId(p.url);
      if (arxivId) {
        onProgress(`[ACADEMIC] Fetching full text: "${p.title.slice(0, 60)}"`);
        const fullText = await fetchArxivFullText(arxivId, signal);
        if (fullText) {
          md = `${headerLine}\n\n${abstractSection}\n\n## Full Paper\n\n${fullText}`;
          onProgress(`[ACADEMIC] ✓ Full text captured: "${p.title.slice(0, 60)}"`);
        } else {
          onProgress(`[ACADEMIC] ✗ PDF unavailable, using abstract: "${p.title.slice(0, 60)}"`);
        }
      }

      // Use arXiv abs URL as canonical source when available
      const sourceUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : (p.url || '');
      const bibtex = generateBibtex({ title: p.title, authors: p.authors, year: p.year, doi: p.doi, venue: p.venue, url: sourceUrl || undefined });
      docIds.push(await indexResearchDoc(projectId, p.title, sourceUrl, md, 'ACADEMIC', bibtex));
      if (sourceUrl) sources.push(sourceEntry(p.title, sourceUrl));
      await savePage({ url: sourceUrl || `paper:${key}`, title: p.title, markdown: md, label: 'ACADEMIC' }).catch(() => {});
    }));
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
  const sources: string[] = [];
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
        onProgress(`[MCP] ${server.name}: calling ${tool.name}…`);
        try {
          const args = topicArgFor(tool);
          args[Object.keys(args)[0]] = topic;
          const text = await conn.callTool(tool.name, args);
          const gate = checkContentQuality(text, `${server.name}/${tool.name}`);
          if (!gate.pass) {
            onProgress(`[MCP] ${server.name}/${tool.name}: result rejected (${gate.reason})`);
            continue;
          }
          const title = `MCP: ${server.name} — ${tool.name} ("${topic.slice(0, 60)}")`;
          docIds.push(await indexResearchDoc(projectId, title, server.url, text, 'MCP'));
          sources.push(`[${title}](${server.url})`);
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

async function saveSynthesisReport(
  projectId: string,
  topic: string,
  synthesis: string,
  sources: string[],
  mode: 'quick' | 'deep'
): Promise<void> {
  const truncatedTopic = topic.length > 120 ? topic.slice(0, 117) + '…' : topic;
  const title = `Deep Research: ${truncatedTopic}`;
  const body = `${synthesis}\n\n## Sources\n${[...new Set(sources)].map(s => `- ${s}`).join('\n')}`;
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
  synthesisFn?: SynthesisStreamFn
): Promise<{ synthesis: string, sources: string[] }> {
  activeLimits = await getResearchLimits();
  activeQuality = await getSourceQuality();
  const depth = await getResearchDepth();
  if (depth !== 'standard') onProgress(`[PLANNING] Research depth: ${depth}`);
  if (activeQuality === 'high') onProgress('[PLANNING] Source quality: high-authority only');

  if (mode === 'deep') {
    return runDeeperResearch(projectId, topic, llmChatFn, onProgress, signal, synthesisFn);
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
      const academic = await runAcademicAgent(projectId, topic, onProgress, signal);
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

  const contextText = buildAnchoredContext(relevantChunks).trim();

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

  const synthesis = await (synthesisFn ?? llmChatFn)(sysPrompt, `SOURCE EXCERPTS:\n\n${contextText}`);

  await saveSynthesisReport(projectId, topic, synthesis, agent.sources, 'quick');

  onProgress(`[DONE] Research complete.`);

  return { synthesis, sources: agent.sources };
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
  const sources: string[] = [];
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
          docIds.push(await indexResearchDoc(projectId, `arXiv:${arxivId}`, url, fullText, 'ACADEMIC'));
          sources.push(sourceEntry(`arXiv:${arxivId}`, url));
          onProgress(`[REFS] ✓ ${url}`);
          continue;
        }
      }
      // DOI or web: scrape it (scrapeUrl handles the DOI→S2 fallback)
      const scraped = await scrapeUrl(ref.url, signal);
      if (scraped?.markdown) {
        docIds.push(await indexResearchDoc(projectId, scraped.title || ref.url, ref.url, scraped.markdown, 'WEB'));
        sources.push(sourceEntry(scraped.title, ref.url));
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

async function runDeeperResearch(
  projectId: string,
  topic: string,
  llmChatFn: (sys: string, user: string) => Promise<string>,
  onProgress: (status: string) => void,
  signal?: AbortSignal,
  synthesisFn?: SynthesisStreamFn
): Promise<{ synthesis: string, sources: string[] }> {

  // Phase 1: strategic planning (reuse a checkpointed plan on resume)
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
  await updateJob({ phase: 'gathering', subQuestions, webQueries }).catch(() => {});

  // Phase 2: staged gathering (Gemini-style). Stage 1 fans out every agent
  // on the planned queries; each later stage analyzes the evidence collected
  // so far and issues NEW web queries targeting the gaps. Stage count comes
  // from the depth tier. Academic/news/MCP run once — re-querying them per
  // stage mostly re-fetches the same papers and burns S2 rate limit.
  const rounds = Math.max(1, activeLimits.rounds);
  const agents: AgentOutcome[] = [];
  let stageQueries = webQueries.slice(0, activeLimits.webQueries);
  let analystNotes = '';

  for (let stage = 1; stage <= rounds; stage++) {
    if (signal?.aborted) throw new Error('AbortError');
    onProgress(`[STAGE ${stage}/${rounds}] Gathering: ${stageQueries.length} quer${stageQueries.length === 1 ? 'y' : 'ies'}…`);

    const stageJobs: Promise<AgentOutcome>[] = [
      runWebAgent(projectId, stageQueries, onProgress, signal, 'WEB')
    ];
    if (stage === 1) {
      stageJobs.push(
        runMcpAgent(projectId, topic, onProgress, signal),
        runAcademicAgent(projectId, topic, onProgress, signal),
        runNewsAgent(projectId, topic, onProgress, signal)
      );
    }
    const outcomes = await Promise.allSettled(stageJobs);
    if (signal?.aborted) throw new Error('AbortError');
    for (const o of outcomes) {
      if (o.status === 'fulfilled') {
        if (o.value.label === 'MCP' && o.value.docIds.length === 0) continue;
        agents.push(o.value);
      } else onProgress(`[AGENTS] An agent failed: ${o.reason}`);
    }

    if (stage === rounds) break;

    // Between stages: what do we know, what's missing, what to search next
    const docsSoFar = agents.flatMap(a => a.docIds);
    if (docsSoFar.length === 0) continue; // nothing to analyze — retry plan queries
    onProgress(`[STAGE ${stage}/${rounds}] Analyzing ${docsSoFar.length} sources for gaps…`);
    const evidenceChunks = await searchSessionChunks(projectId, topic, 20, docsSoFar);
    const evidence = evidenceChunks.map(c => c.text).join('\n\n');

    // Link-following: chase references found inside the sources (depth), in
    // parallel with the gap-query breadth. Capped at ⅓ of the stage budget.
    const seenUrls = new Set((await listPages().catch(() => [])).map(p => p.url));
    const refs = harvestReferences(evidenceChunks.map(c => c.text), { seenUrls, isJunk: isJunkUrl });
    if (refs.length > 0) {
      const refBudget = Math.max(2, Math.floor(activeLimits.urlsPerQuery / 3));
      const refOutcome = await followReferences(projectId, topic, refs, refBudget, onProgress, signal);
      if (refOutcome.docIds.length > 0) agents.push(refOutcome);
    }

    const analysis = await analyzeGaps(topic, subQuestions, evidence, llmChatFn);
    if (!analysis) {
      onProgress(`[STAGE ${stage}/${rounds}] Gap analysis inconclusive — finishing gathering early`);
      break;
    }
    analystNotes += `Stage ${stage}: ${analysis.findings}\n`;
    stageQueries = analysis.queries;
    onProgress(`[STAGE ${stage}/${rounds}] Next: ${analysis.queries.join(' | ')}`);
    await updateJob({ webQueries: analysis.queries }).catch(() => {});
  }

  const allDocIds = agents.flatMap(a => a.docIds);
  const allSources = [...new Set(agents.flatMap(a => a.sources))];
  if (allDocIds.length === 0) {
    throw new Error('No agent could gather any sources.');
  }
  const labelByDoc = new Map<string, AgentLabel>();
  agents.forEach(a => a.docIds.forEach(d => labelByDoc.set(d, a.label)));

  // Disclose the source mix — a lopsided mix means one discovery channel failed
  const mixSummary = agents.map(a => `${a.label} ${a.sources.length}`).join(' · ');
  onProgress(`[AGENTS] Source mix — ${mixSummary}`);
  const emptyAgents = agents.filter(a => a.docIds.length === 0).map(a => a.label);
  if (emptyAgents.length > 0) {
    onProgress(`[AGENTS] Warning: ${emptyAgents.join(', ')} returned nothing — report will lean on the remaining source types`);
  }

  // Phase 3: evidence retrieval across topic + sub-questions
  onProgress(`[CROSS-REF] Retrieving evidence for ${subQuestions.length + 1} angles across ${allDocIds.length} sources…`);
  const chunkSet = new Map<string, any>();
  for (const q of [topic, ...subQuestions]) {
    if (signal?.aborted) throw new Error('AbortError');
    const chunks = await searchSessionChunks(projectId, q, activeLimits.chunksPerAngle, allDocIds);
    chunks.forEach(c => chunkSet.set(c.id, c));
    if (chunkSet.size >= activeLimits.chunkPoolCap) break;
  }

  // Balance the evidence across source types: round-robin by agent label so
  // one over-supplied channel (e.g. academic) can't crowd out the others.
  const byLabel = new Map<string, any[]>();
  for (const c of chunkSet.values()) {
    const l = labelByDoc.get(c.docId) || 'WEB';
    if (!byLabel.has(l)) byLabel.set(l, []);
    byLabel.get(l)!.push(c);
  }
  // Pack round-robin until the model's context budget is spent — a fixed
  // chunk count either starves big-context models or silently truncates
  // small ones.
  const charBudget = await getSynthesisCharBudget();
  const relevantChunks: any[] = [];
  const labelOrder = [...byLabel.keys()];
  let usedChars = 0;
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

  // Anchor each chunk's origin tag onto its heading so the LLM can weave
  // [WEB]/[ACADEMIC]/[NEWS] provenance into the citation without losing the
  // real anchor ID needed for click-through.
  const anchoredChunks = relevantChunks.map(c => ({
    ...c,
    heading: `[${labelByDoc.get(c.docId) || 'WEB'}] ${c.heading || ''}`.trim()
  }));
  const contextText = buildAnchoredContext(anchoredChunks).trim();

  if (contextText.length < 100) {
    throw new Error(
      `Agents found ${allSources.length} source(s) but could not extract readable text. ` +
      `Try a different topic or check your connection.`
    );
  }

  // Phase 4: cross-referenced synthesis
  onProgress(`[SYNTHESIZING] Cross-referencing ${relevantChunks.length} excerpts and drafting the report…`);
  await updateJob({ phase: 'synthesizing' }).catch(() => {});

  const sysPrompt = `You are a senior research analyst. Using ONLY the excerpts below (each preceded by a [WEB]/[ACADEMIC]/[NEWS] origin tag in its heading), write a deep, well-structured markdown report on: "${topic}".

Requirements:
1. Address each of these sub-questions in its own section:
${subQuestions.map(q => `   - ${q}`).join('\n')}
2. Cross-reference the origins: where web, academic and news sources agree, cite all of the agreeing anchors together (e.g. [d1.s0.p1][d2.s3.p0]) — this is what demonstrates consensus. Where sources conflict, call out the contradiction explicitly and cite each side.
3. End with an "Open Questions & Gaps" section for aspects the sources do not cover.
Never ask for more context — work with what is provided.

${RESEARCH_CITATION_RULES}`;

  const notesBlock = analystNotes ? `ANALYST NOTES FROM GATHERING STAGES (context, not citable):\n${analystNotes}\n\n` : '';
  let synthesis = await (synthesisFn ?? llmChatFn)(sysPrompt, `${notesBlock}SOURCE EXCERPTS:\n\n${contextText}`);

  // Prepend the source mix so the reader can judge coverage at a glance
  synthesis = `> **Source mix:** ${mixSummary}` +
    (emptyAgents.length > 0 ? ` — *${emptyAgents.join(', ')} found no usable sources for this topic*` : '') +
    `\n\n${synthesis}`;

  await saveSynthesisReport(projectId, topic, synthesis, allSources, 'deep');

  onProgress(`[DONE] Multi-agent research complete — ${allSources.length} sources across ${agents.length} agents.`);

  return { synthesis, sources: allSources };
}
