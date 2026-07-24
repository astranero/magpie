// ─────────────────────────────────────────────
// Free, keyless search APIs + keyed human-opinion APIs
// ─────────────────────────────────────────────
// Quality tiers control which sources are used. HIGH = authoritative/cited
// (academic, encyclopedic, expert). MEDIUM = structured knowledge & human
// discussion. LOW = lowest-priority fallback.
//
// The /academic command filters to HIGH only.
//
// Rate limits (generous):
//   Wikipedia:      ~200 req/s
//   StackExchange:  300 req/day per IP (keyless)
//   HackerNews:     ~60 req/min (Firebase)
//   Open Library:   ~100 req/min
//   Wikidata:       ~200 req/min
//   OSM Nominatim:  1 req/sec

import type { SearchHit } from './search-providers';

/** Quality tier for a search API. `high` = authoritative/cited sources
 *  (academic papers, expert Q&A, encyclopedic). `medium` = general knowledge
 *  (news, human discussion, structured data). `low` = lowest-priority fallback. */
export type QualityTier = 'high' | 'medium' | 'low';

export interface TieredSearchHit extends SearchHit {
  tier: QualityTier;
  /** Machine-readable source label for the /academic filter gate. */
  source: 'wikipedia' | 'wikidata' | 'openlibrary' | 'stackexchange' |
          'hackernews' | 'reddit' | 'osm' | 'trustpilot' | 'youtube' | 'free-other';
}

// ─────────────────────────────────────────────
// Wikipedia — general knowledge, facts, definitions
// ─────────────────────────────────────────────

export async function wikipediaSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json&origin=*`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  const titles: string[] = data[1] || [];
  const snippets: string[] = data[2] || [];
  const urls: string[] = data[3] || [];
  return titles.map((title, i) => ({
    url: urls[i] || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    title,
    snippet: snippets[i] || '',
  }));
}

export async function wikipediaPageSummary(title: string, signal?: AbortSignal): Promise<string | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.extract || null;
}

// ─────────────────────────────────────────────
// Wikitionary — word definitions, translations, etymology
// ─────────────────────────────────────────────

export async function wiktionarySearch(term: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://en.wiktionary.org/w/api.php?action=opensearch&search=${encodeURIComponent(term)}&limit=3&namespace=0&format=json&origin=*`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  const titles: string[] = data[1] || [];
  const snippets: string[] = data[2] || [];
  const urls: string[] = data[3] || [];
  return titles.map((title, i) => ({
    url: urls[i] || `https://en.wiktionary.org/wiki/${encodeURIComponent(title)}`,
    title,
    snippet: snippets[i]?.replace(/<[^>]+>/g, '').slice(0, 300) || '',
  }));
}

// ─────────────────────────────────────────────
// PubMed — biomedical literature (free, no key)
// ─────────────────────────────────────────────
// NCBI E-utilities: ~3 req/sec without API key, 10 req/sec with key.
// 40M+ papers, covers medicine, biology, health, life sciences.
// Used as a HIGH tier source for academic research.

export async function pubmedSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  // Step 1: search for paper IDs
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=5&retmode=json&sort=relevance`;
  const searchRes = await fetch(searchUrl, { signal });
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const ids: string[] = searchData?.esearchresult?.idlist || [];
  if (ids.length === 0) return [];

  // Step 2: fetch summaries (title, authors, source, pub date, DOI)
  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.slice(0, 5).join(',')}&retmode=json`;
  const summaryRes = await fetch(summaryUrl, { signal });
  if (!summaryRes.ok) return [];
  const summaryData = await summaryRes.json();
  const results = summaryData?.result || {};

  return ids.slice(0, 5).map((id: string) => {
    const r = results[id];
    if (!r) return null;
    const title = r.title || '';
    const authors = (r.authors || []).slice(0, 3).map((a: any) => a.name).join(', ');
    const source = r.source || '';
    const pubDate = r.pubdate || '';
    const doi = r.elocationid?.startsWith('doi: ') ? r.elocationid.slice(5) : '';
    const pmid = r.uid || id;
    const snippet = [authors && `by ${authors}`, source, pubDate].filter(Boolean).join(' | ');
    return {
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      title,
      snippet,
    };
  }).filter((h): h is NonNullable<typeof h> => h !== null && !!h.title);
}

// ─────────────────────────────────────────────
// Wikidata — structured knowledge graph (entities, properties, relationships)
// ─────────────────────────────────────────────

export async function wikidataSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&limit=5&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.search || [])
    .map((e: any) => ({
      url: `https://www.wikidata.org/wiki/${e.id}`,
      title: e.label || e.id || '',
      snippet: e.description || '',
    }))
    .filter((h: SearchHit) => h.title);
}

// ─────────────────────────────────────────────
// Open Library — books, authors, subjects
// ─────────────────────────────────────────────

export async function openLibrarySearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.docs || [])
    .slice(0, 5)
    .map((d: any) => {
      const title = d.title || '';
      const author = d.author_name?.[0] || '';
      const year = d.first_publish_year || '';
      const subjects = (d.subject || []).slice(0, 3).join(', ');
      const snippet = [author && `by ${author}`, year && `(${year})`, subjects && `— ${subjects}`].filter(Boolean).join(' ');
      return {
        url: d.key ? `https://openlibrary.org${d.key}` : '',
        title,
        snippet,
      };
    })
    .filter((h: SearchHit) => h.url);
}

// ─────────────────────────────────────────────
// OpenStreetMap Nominatim — geocoding, places, addresses
// ─────────────────────────────────────────────

export async function osmSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=3&addressdetails=1`;
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': 'MagpieResearchAssistant/2.0' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data) ? data : [])
    .map((p: any) => ({
      url: `https://www.openstreetmap.org/${p.osm_type || 'node'}/${p.osm_id || ''}`,
      title: p.display_name?.split(',')[0] || p.name || '',
      snippet: p.display_name || '',
    }))
    .filter((h: SearchHit) => h.title);
}

// ─────────────────────────────────────────────
// Stack Exchange — technical Q&A (programming, serverfault, superuser)
// ─────────────────────────────────────────────

const STACK_EXCHANGE_SITES = [
  'stackoverflow',
  'serverfault',
  'superuser',
  'softwareengineering',
  'codereview',
];

export async function stackExchangeSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const results: SearchHit[] = [];
  for (const site of STACK_EXCHANGE_SITES) {
    try {
      const url = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&site=${site}&q=${encodeURIComponent(query)}&pagesize=2&filter=!nNPvSNVZJS`;
      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.items || []).slice(0, 2)) {
        results.push({
          url: item.question_id
            ? `https://${site}.com/questions/${item.question_id}/${item.title?.toLowerCase().replace(/\s+/g, '-') || ''}`
            : '',
          title: item.title || '',
          snippet: item.excerpt?.replace(/<[^>]+>/g, '').slice(0, 300) || '',
        });
      }
    } catch { /* site failure — skip */ }
  }
  return results.filter(h => h.url);
}

// ─────────────────────────────────────────────
// HackerNews — tech news, startups, discussion
// ─────────────────────────────────────────────

export async function hackerNewsSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=5&tags=story`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.hits || [])
    .map((h: any) => ({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title || '',
      snippet: `${h.points || 0} points · ${h.num_comments || 0} comments · by ${h.author || 'anonymous'}`,
    }))
    .filter((h: SearchHit) => h.title);
}

// ─────────────────────────────────────────────
// Open Trivia DB — trivia questions and answers
// ─────────────────────────────────────────────

export async function triviaSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  // Try to match a category from the query; default to general knowledge (9).
  const categoryMap: Record<string, number> = {
    general: 9, books: 10, film: 11, music: 12, theatre: 13, tv: 14,
    television: 14, video: 15, games: 15, board: 16, science: 17,
    computer: 18, math: 19, mythology: 20, sports: 21, geography: 22,
    history: 23, politics: 24, art: 25, celebrity: 26, animal: 27,
    nature: 27, vehicle: 28,
  };
  let category = 9;
  for (const [kw, id] of Object.entries(categoryMap)) {
    if (query.toLowerCase().includes(kw)) { category = id; break; }
  }
  const url = `https://opentdb.com/api.php?amount=3&category=${category}&type=multiple`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((q: any) => {
    const correct = q.correct_answer || '';
    const wrong = (q.incorrect_answers || []).join(', ');
    return {
      url: '',
      title: q.question?.replace(/&[^;]+;/g, '') || '',
      snippet: `Answer: ${correct} | Options: ${correct}, ${wrong}`.replace(/&[^;]+;/g, ''),
    };
  });
}

// ─────────────────────────────────────────────
// Reddit — authentic human discussions across ALL topics (OAuth2 — keyed)
// ─────────────────────────────────────────────
// Free: register a "script" app at https://www.reddit.com/prefs/apps →
// get client_id. The keyless .json endpoint is unreliable (Reddit blocks
// aggressively), so we use OAuth2 for consistent access.
// Configure: redditClientId, redditClientSecret in searchApiKeys.

async function getRedditAccessToken(clientId: string, clientSecret: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=read',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

export async function redditSearch(query: string, signal?: AbortSignal, clientId?: string, clientSecret?: string): Promise<SearchHit[]> {
  if (!clientId || !clientSecret) return [];
  const token = await getRedditAccessToken(clientId, clientSecret, signal);
  if (!token) return [];

  const url = `https://oauth.reddit.com/r/all/search?q=${encodeURIComponent(query)}&limit=10&sort=relevance&raw_json=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'MagpieResearchAssistant/2.0 (by /u/magpie)',
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const posts = data?.data?.children || [];
  return posts
    .filter((c: any) => c.kind === 't3')
    .slice(0, 10)
    .map((c: any) => {
      const p = c.data || {};
      const selfText = (p.selftext || '').replace(/\s+/g, ' ').slice(0, 400);
      return {
        url: `https://www.reddit.com${p.permalink || ''}`,
        title: p.title || '',
        snippet: selfText || `r/${p.subreddit} · ${p.score || 0} points · ${p.num_comments || 0} comments`,
        tier: 'medium' as QualityTier,
        source: 'reddit',
      };
    })
    .filter((h: SearchHit) => h.url);
}

// ─────────────────────────────────────────────
// Trustpilot — product/service reviews (keyed — free API key)
// ─────────────────────────────────────────────
// Users configure a free API key from developers.trustpilot.com in Settings.
// The key is stored alongside other search API keys (Tavily/Brave/Serper).

export async function trustpilotSearch(query: string, signal?: AbortSignal, key?: string): Promise<TieredSearchHit[]> {
  if (!key) return [];
  // Find business unit by domain-like query
  const buRes = await fetch(
    `https://api.trustpilot.com/v1/business-units/find?name=${encodeURIComponent(query)}`,
    { signal, headers: { apikey: key } }
  );
  if (!buRes.ok) return [];
  const bu = await buRes.json();
  const buId = bu.id || bu.businessUnitId;
  if (!buId) return [];

  // Get latest reviews
  const revRes = await fetch(
    `https://api.trustpilot.com/v1/business-units/${buId}/reviews?pageSize=5&sortBy=createdat.desc`,
    { signal, headers: { apikey: key } }
  );
  if (!revRes.ok) return [];
  const revData = await revRes.json();
  return (revData.reviews || []).map((r: any) => ({
    url: `https://www.trustpilot.com/review/${bu.websiteUrl || ''}`,
    title: `${bu.name || ''} — ${r.stars || '?'}/5 review`,
    snippet: r.title ? `${r.title}: ${r.text?.slice(0, 300) || ''}` : (r.text?.slice(0, 300) || ''),
  }));
}

// ─────────────────────────────────────────────
// YouTube Comments — video comments & discussion (keyed — free Google key)
// ─────────────────────────────────────────────
// Users configure a free Google Cloud API key. Searches for videos matching
// the query, then fetches top comments from the most relevant video.

export async function youtubeSearch(query: string, signal?: AbortSignal, key?: string): Promise<SearchHit[]> {
  if (!key) return [];
  // Step 1: find videos matching the query
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&maxResults=3&type=video&key=${key}`;
  const searchRes = await fetch(searchUrl, { signal });
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const videos = searchData.items || [];
  if (videos.length === 0) return [];

  const results: SearchHit[] = [];
  for (const video of videos) {
    const videoId = video.id?.videoId;
    const videoTitle = video.snippet?.title || '';
    if (!videoId) continue;

    // Step 2: get top comments for this video
    const commentsUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=5&order=relevance&key=${key}`;
    const commentsRes = await fetch(commentsUrl, { signal });
    if (!commentsRes.ok) continue;
    const commentsData = await commentsRes.json();
    const threads = commentsData.items || [];

    for (const thread of threads.slice(0, 3)) {
      const cs = thread.snippet?.topLevelComment?.snippet || {};
      results.push({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: `Comment on: ${videoTitle}`,
        snippet: (cs.textDisplay || '').replace(/<[^>]+>/g, '').slice(0, 300),
      });
    }
  }
  return results;
}

// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// GitHub — search repos, issues, discussions (free, no key)
// ─────────────────────────────────────────────
export async function githubSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`;
  const res = await fetch(url, {
    signal,
    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MagpieResearchAssistant/2.0' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((r: any) => ({
    url: r.html_url || '',
    title: r.full_name || r.name || '',
    snippet: [r.description?.slice(0, 200), `⭐ ${r.stargazers_count} · ${r.language || '?'} · ${r.forks_count} forks`].filter(Boolean).join('\n'),
  })).filter((h: SearchHit) => h.url);
}

// ─────────────────────────────────────────────
// ClinicalTrials.gov — clinical trial registry (free, no key)
// ─────────────────────────────────────────────
export async function clinicalTrialsSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(query)}&pageSize=5&format=json&sort=@lastupdat`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.studies || []).map((s: any) => {
    const m = s.protocolSection?.identificationModule || {};
    const status = s.protocolSection?.statusModule?.overallStatus || '';
    return {
      url: `https://clinicaltrials.gov/study/${m.nctId || ''}`,
      title: m.briefTitle || m.officialTitle || '',
      snippet: `NCT${m.nctId || ''} · ${status}`,
    };
  }).filter((h: SearchHit) => h.url && h.title);
}

// ─────────────────────────────────────────────
// bioRxiv — biology preprints (free, no key, date-range API)
// ─────────────────────────────────────────────
export async function biorxivSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const today = new Date();
  const endDate = today.toISOString().split('T')[0];
  const startDate = new Date(today.getTime() - 30 * 86400000).toISOString().split('T')[0];
  const url = `https://api.biorxiv.org/details/biorxiv/${startDate}/${endDate}/0/20`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  const papers = data.collection || [];
  const qLower = query.toLowerCase();
  return papers
    .filter((p: any) =>
      (p.title || '').toLowerCase().includes(qLower) ||
      (p.abstract || '').toLowerCase().includes(qLower) ||
      (p.category || '').toLowerCase().includes(qLower)
    )
    .slice(0, 5)
    .map((p: any) => ({
      url: `https://www.biorxiv.org/content/${p.doi || ''}`,
      title: p.title || '',
      snippet: [p.category, p.author, p.date].filter(Boolean).join(' · '),
    }))
    .filter((h: SearchHit) => h.title);
}

// ─────────────────────────────────────────────
// UniProt — protein sequences and info (free, no key)
// ─────────────────────────────────────────────
export async function uniprotSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&size=5&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r: any) => {
    const name = r.proteinDescription?.recommendedName?.fullName?.value || r.proteinDescription?.submittedName?.[0]?.fullName?.value || '';
    const gene = (r.genes || []).map((g: any) => g.geneName?.value).filter(Boolean).join(', ');
    return {
      url: `https://www.uniprot.org/uniprotkb/${r.primaryAccession}/entry`,
      title: `${r.primaryAccession} · ${name.slice(0, 80)}`,
      snippet: [gene, r.organism?.scientificName, `${r.sequence?.length || '?'} aa`].filter(Boolean).join(' · '),
    };
  }).filter((h: SearchHit) => h.title);
}

// Combined free search — try each API in relevance order.
// Also tries keyed APIs (Trustpilot, YouTube) when user configured keys.
// Returns the FIRST provider that returns results.
// ─────────────────────────────────────────────

export async function searchFreeAPIs(query: string, signal?: AbortSignal, minTier?: QualityTier): Promise<SearchHit[]> {
  const minLevel = minTier || 'low';
  const levelOrder: QualityTier[] = ['high', 'medium', 'low'];
  const minIdx = levelOrder.indexOf(minLevel);

  // Read keyed API keys from storage (same store as Tavily/Brave/Serper).
  let trustpilotKey: string | undefined;
  let youtubeKey: string | undefined;
  let redditId: string | undefined;
  let redditSecret: string | undefined;
  try {
    const s = await chrome.storage.local.get(['searchApiKeys']);
    const keys = (s.searchApiKeys || {}) as any;
    trustpilotKey = keys.trustpilot || undefined;
    youtubeKey = keys.youtube || undefined;
    redditId = keys.redditId || undefined;
    redditSecret = keys.redditSecret || undefined;
  } catch { /* use defaults */ }

  interface FreeAPIEntry {
    name: string;
    tier: QualityTier;
    run: () => Promise<SearchHit[]>;
  }

  const allAPIs: FreeAPIEntry[] = [
    { name: 'Wikipedia',    tier: 'high' as const,   run: () => wikipediaSearch(query, signal) },
    { name: 'Wikidata',     tier: 'high' as const,   run: () => wikidataSearch(query, signal) },
    { name: 'PubMed',       tier: 'high' as const,   run: () => pubmedSearch(query, signal) },
    { name: 'ClinicalTrials',tier: 'high' as const,  run: () => clinicalTrialsSearch(query, signal) },
    { name: 'bioRxiv',      tier: 'high' as const,   run: () => biorxivSearch(query, signal) },
    { name: 'UniProt',      tier: 'high' as const,   run: () => uniprotSearch(query, signal) },
    { name: 'StackExchange',tier: 'high' as const,   run: () => stackExchangeSearch(query, signal) },
    { name: 'GitHub',       tier: 'medium' as const, run: () => githubSearch(query, signal) },
    { name: 'Reddit',       tier: 'medium' as const, run: () => redditSearch(query, signal, redditId, redditSecret) },
    { name: 'OpenLibrary',  tier: 'medium' as const, run: () => openLibrarySearch(query, signal) },
    { name: 'HackerNews',   tier: 'medium' as const, run: () => hackerNewsSearch(query, signal) },
    { name: 'OpenStreetMap',tier: 'medium' as const, run: () => osmSearch(query, signal) },
    { name: 'Trustpilot',   tier: 'low' as const,    run: () => trustpilotSearch(query, signal, trustpilotKey) },
    { name: 'YouTube',      tier: 'low' as const,    run: () => youtubeSearch(query, signal, youtubeKey) },
  ];

  const eligible = allAPIs.filter(a => levelOrder.indexOf(a.tier) >= minIdx);
  for (const { name, run } of eligible) {
    try {
      const hits = await run();
      if (hits.length > 0) {
        console.log(`[FreeAPI] ${name} (${minTier || 'all'}): ${hits.length} hits for "${query.slice(0, 60)}"`);
        return hits;
      }
    } catch (e) {
      console.warn(`[FreeAPI] ${name} failed for "${query.slice(0, 60)}"`, e);
    }
  }
  return [];
}

/** Alias that only returns high-quality sources — for /academic research. */
export function searchFreeAPIsHighQuality(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  return searchFreeAPIs(query, signal, 'high');
}