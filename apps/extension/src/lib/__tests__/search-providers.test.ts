import { describe, it, expect, vi, afterEach } from 'vitest';
import { jinaWebSearch } from '../search-providers';

afterEach(() => { vi.restoreAllMocks(); });

describe('jinaWebSearch', () => {
  it('parses s.jina.ai results into SearchHit[] with snippets', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: [
          { title: 'Best game engines 2026', url: 'https://a.example/engines', description: 'Unity and Godot compared for mobile.' },
          { title: 'Godot mobile guide', url: 'https://b.example/godot', description: 'Exporting to Android and iOS.' },
        ],
      }),
    }));
    (globalThis as any).fetch = fetchMock;

    const hits = await jinaWebSearch('mobile game engines', 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ url: 'https://a.example/engines', title: 'Best game engines 2026', snippet: 'Unity and Godot compared for mobile.' });
    // no-content mode: fast metadata request
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers['X-Respond-With']).toBe('no-content');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('sends a Bearer header when a key is provided', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    (globalThis as any).fetch = fetchMock;
    await jinaWebSearch('x', 3, undefined, 'jina_key');
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers.Authorization).toBe('Bearer jina_key');
  });

  it('throws on a non-ok response so callers fall back', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(jinaWebSearch('x', 3)).rejects.toThrow(/429/);
  });
});
