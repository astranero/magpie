import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gatherWebSnippets } from '../deep-researcher';

// gatherWebSnippets powers chat's "search the web when the workspace has no
// match" fallback. It reuses the research search→scrape chain, so these tests
// drive it through mocked fetch + chrome (no keys → DDG scrape → Jina reader).

const PROSE =
  'The finale reveals that the quiet bookstore owner orchestrated the killings. ' +
  'He used the shop as a cover, tracking each victim through their special orders, ' +
  'and the detective only pieces it together after finding the annotated first edition. ' +
  'The motive traces back to a decades old betrayal involving the founding families of the town, ' +
  'which the show seeds through flashbacks across the season before the confrontation in the archive room.';

function ddgHtml(urls: string[]): string {
  return urls
    .map(u => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}">result</a>`)
    .join('\n');
}

function jinaDoc(title: string): string {
  return `Title: ${title}\nURL Source: x\nMarkdown Content:\n${PROSE}`;
}

function installChrome(mcpServers: any[] = [], searchApiKeys?: any) {
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const k = Array.isArray(keys) ? keys : [keys];
          const out: any = {};
          if (k.includes('mcpServers')) out.mcpServers = mcpServers;
          if (k.includes('searchApiKeys') && searchApiKeys) out.searchApiKeys = searchApiKeys;
          if (k.includes('mcpSeeded')) out.mcpSeeded = true; // don't re-seed defaults
          return out; // searchApiKeys absent → no keys → DDG path
        }),
        set: vi.fn(async () => {}),
      },
    },
    runtime: { sendMessage: vi.fn(async () => ({ ok: false })) },
  };
}

describe('gatherWebSnippets (chat web fallback)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installChrome();
  });

  it('searches, scrapes, and returns numbered [W#] context + sources', async () => {
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      const body = url.includes('duckduckgo.com/html')
        ? ddgHtml(['https://example.com/finale', 'https://example.org/recap'])
        : url.includes('r.jina.ai/') ? jinaDoc(url.includes('example.com') ? 'Recap One' : 'Recap Two') : null;
      if (body == null) throw new Error(`unexpected fetch ${url}`);
      return { ok: true, headers: { get: () => 'text/plain' }, text: async () => body, url } as any;
    });

    const { context, sources } = await gatherWebSnippets('is the bookstore guy the killer');

    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(context).toMatch(/\[W1\]/);
    expect(context).toContain('bookstore owner orchestrated');
    expect(sources[0].url).toMatch(/^https?:\/\//);
  });

  it('answers from provider snippets WITHOUT fetching pages (the fast path)', async () => {
    installChrome([], { serper: 'test-key' });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('serper.dev')) {
        return {
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({
            organic: [
              { link: 'https://a.example/1', title: 'Alpha', snippet: 'The bookstore owner is the confirmed antagonist, revealed in the season finale after the detective finds the annotated first edition.' },
              { link: 'https://b.example/2', title: 'Beta', snippet: 'A recap notes the reveal is seeded through flashbacks across the season before the archive-room confrontation with the owner.' },
            ],
          }),
          text: async () => '', url,
        } as any;
      }
      throw new Error(`should not fetch pages on the snippet fast path: ${url}`);
    });
    (globalThis as any).fetch = fetchMock;

    const { context, sources } = await gatherWebSnippets('is the bookstore guy the killer');

    expect(sources.length).toBe(2);
    expect(context).toContain('[W1]');
    expect(context).toContain('confirmed antagonist');
    // No jina/DDG page fetch happened — only the one search call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(c => String(c[0]).includes('serper.dev'))).toBe(true);
  });

  it('returns empty when the search yields no usable results', async () => {
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      // DDG + Jina both return a page with no result links
      const body = url.includes('duckduckgo') || url.includes('jina') ? '<html>no results here</html>' : null;
      if (body == null) throw new Error(`unexpected fetch ${url}`);
      return { ok: true, headers: { get: () => 'text/html' }, text: async () => body, url } as any;
    });

    const { context, sources } = await gatherWebSnippets('a question with no answers online xyzzy');
    expect(context).toBe('');
    expect(sources).toEqual([]);
  });

  it('merges results from an enabled search MCP', async () => {
    installChrome([{ id: 's1', name: 'DocsMCP', url: 'https://mcp.example.test/mcp', enabled: true }]);
    const mcpText =
      'The bookstore owner is confirmed as the antagonist in the official episode guide, ' +
      'with production notes describing the reveal as the season’s central twist.';

    (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
      // Web search finds nothing → only the MCP contributes.
      if (url.includes('duckduckgo') || url.includes('jina')) {
        return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>no results</html>', url } as any;
      }
      if (url.includes('mcp.example.test')) {
        const body = JSON.parse(init.body);
        const reply: any = { jsonrpc: '2.0', id: body.id };
        if (body.method === 'initialize') reply.result = { capabilities: {} };
        else if (body.method === 'tools/list') reply.result = { tools: [{ name: 'search_docs', description: 'search the knowledge base', inputSchema: { properties: { query: {} } } }] };
        else if (body.method === 'tools/call') reply.result = { content: [{ type: 'text', text: mcpText }] };
        else reply.result = {};
        return { ok: true, headers: { get: () => 'application/json', }, json: async () => reply, text: async () => JSON.stringify(reply), url } as any;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { context, sources } = await gatherWebSnippets('is the bookstore guy the killer');
    expect(sources.some(s => s.title.includes('DocsMCP'))).toBe(true);
    expect(context).toContain('central twist');
  });

  it('honors the deadline and returns fast when fetches hang', async () => {
    // Every fetch would take 5s; the deadline must abort them well before that
    // so a chat turn never sits "Searching the web…" for a minute (the freeze).
    (globalThis as any).fetch = vi.fn((_url: string, init?: any) => new Promise((resolve, reject) => {
      const s = init?.signal;
      if (s?.aborted) return reject(new Error('AbortError'));
      const t = setTimeout(() => resolve({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>slow</html>', url: _url } as any), 5000);
      s?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('AbortError')); }, { once: true });
    }));

    const start = Date.now();
    const { context, sources } = await gatherWebSnippets('slow query', { deadlineMs: 100 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(context).toBe('');
    expect(sources).toEqual([]);
  });
});
