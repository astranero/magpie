// ─────────────────────────────────────────────
// Pluggable web-search providers ("Research APIs")
// ─────────────────────────────────────────────
// Users can link their own search API keys (Config → Research APIs). When a
// key is present, the web agent queries that provider instead of the fragile
// DDG-scrape fallback chain — better results, no anti-bot roulette. Keys are
// tried in order; the first configured provider that answers wins. No keys →
// the built-in DDG/Jina path runs unchanged.

export interface SearchApiKeys {
  tavily?: string;
  brave?: string;
  serper?: string;
}

export async function getSearchApiKeys(): Promise<SearchApiKeys> {
  try {
    const s = await chrome.storage.local.get(['searchApiKeys']);
    return (s.searchApiKeys as SearchApiKeys) || {};
  } catch {
    return {};
  }
}

export async function saveSearchApiKeys(keys: SearchApiKeys): Promise<void> {
  await chrome.storage.local.set({ searchApiKeys: keys });
}

async function tavilySearch(key: string, query: string, maxResults: number, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' })
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r: any) => r.url).filter(Boolean);
}

async function braveSearch(key: string, query: string, maxResults: number, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}`,
    { signal, headers: { 'Accept': 'application/json', 'X-Subscription-Token': key } }
  );
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map((r: any) => r.url).filter(Boolean);
}

async function serperSearch(key: string, query: string, maxResults: number, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: Math.min(maxResults, 20) })
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json();
  return (data.organic || []).map((r: any) => r.link).filter(Boolean);
}

/**
 * Search using the user's linked providers. Returns [] when no provider is
 * configured or every configured provider failed — callers fall back to the
 * built-in scrape chain.
 */
export async function searchWithProviders(query: string, maxResults: number, signal?: AbortSignal): Promise<string[]> {
  const keys = await getSearchApiKeys();
  const attempts: Array<[string, () => Promise<string[]>]> = [];
  if (keys.tavily) attempts.push(['Tavily', () => tavilySearch(keys.tavily!, query, maxResults, signal)]);
  if (keys.brave) attempts.push(['Brave', () => braveSearch(keys.brave!, query, maxResults, signal)]);
  if (keys.serper) attempts.push(['Serper', () => serperSearch(keys.serper!, query, maxResults, signal)]);

  for (const [name, run] of attempts) {
    try {
      const urls = await run();
      if (urls.length > 0) return urls;
    } catch (e) {
      console.warn(`${name} search failed for "${query}"`, e);
    }
  }
  return [];
}
