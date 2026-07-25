import { describe, it, expect, vi } from 'vitest';
import { isAllowedFetchUrl, redactObservedUrl, fetchJson } from '../fetch-guard';

describe('isAllowedFetchUrl', () => {
  it('allows https to any host', () => {
    expect(isAllowedFetchUrl('https://www.nettimoto.com/api/search?make=110')).toBe(true);
    expect(isAllowedFetchUrl('https://www.reddit.com/r/motorcycles/search.json?q=v-strom')).toBe(true);
  });
  it('allows http only to loopback', () => {
    expect(isAllowedFetchUrl('http://localhost:3920/api')).toBe(true);
    expect(isAllowedFetchUrl('http://127.0.0.1:8080/x')).toBe(true);
    expect(isAllowedFetchUrl('http://example.com/api')).toBe(false); // public http denied
  });
  it('rejects non-http(s) schemes', () => {
    expect(isAllowedFetchUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedFetchUrl('ftp://x/y')).toBe(false);
    expect(isAllowedFetchUrl('not a url')).toBe(false);
  });
  it('rejects static assets and tracking hosts', () => {
    expect(isAllowedFetchUrl('https://cdn.site.com/app.js')).toBe(false);
    expect(isAllowedFetchUrl('https://site.com/logo.png')).toBe(false);
    expect(isAllowedFetchUrl('https://www.google-analytics.com/collect?x=1')).toBe(false);
    expect(isAllowedFetchUrl('https://sentry.io/api/1/store/')).toBe(false);
  });
});

describe('redactObservedUrl', () => {
  it('redacts token-like values by key name', () => {
    const out = redactObservedUrl('https://api.site.com/v1/list?token=abc123&page=2&make=110');
    expect(out).toContain('token=%E2%80%B9redacted%E2%80%BA');
    expect(out).toContain('page=2');       // pagination kept
    expect(out).toContain('make=110');      // filter kept
  });
  it('redacts high-entropy values even under a benign key', () => {
    const out = redactObservedUrl('https://api.site.com/x?ref=8f3a2b1c9d4e5f60718293a4b5c6d7e8');
    expect(out).toContain('ref=%E2%80%B9redacted%E2%80%BA');
  });
  it('strips fragment and userinfo, keeps ordinary params', () => {
    const out = redactObservedUrl('https://u:p@api.site.com/x?q=v-strom#frag');
    expect(out).not.toContain('#frag');
    expect(out).not.toContain('u:p@');
    expect(out).toContain('q=v-strom');
  });
});

describe('fetchJson', () => {
  const jsonResp = (obj: any, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json' },
  });

  it('blocks a disallowed URL without fetching', async () => {
    const doFetch = vi.fn();
    const r = await fetchJson('http://evil.com/x', { doFetch: doFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/policy/i);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('returns parsed JSON and never sends credentials', async () => {
    const doFetch = vi.fn(async () => jsonResp({ items: [1, 2, 3] })) as any;
    const r = await fetchJson('https://api.site.com/list', { doFetch });
    expect(r.json).toEqual({ items: [1, 2, 3] });
    expect(doFetch).toHaveBeenCalledWith('https://api.site.com/list', expect.objectContaining({ credentials: 'omit' }));
  });

  it('caps an oversized body', async () => {
    const big = 'x'.repeat(200_000);
    const doFetch = vi.fn(async () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } })) as any;
    const r = await fetchJson('https://api.site.com/big', { maxChars: 1000, doFetch });
    expect(r.text!.length).toBe(1000);
  });
});
