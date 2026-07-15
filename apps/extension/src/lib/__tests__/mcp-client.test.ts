import { describe, it, expect, vi } from 'vitest';
import { McpConnection, isSearchLikeTool, topicArgFor, argsForQuery, isAllowedMcpUrl } from '../mcp-client';

describe('isAllowedMcpUrl (URL policy: https or loopback-http)', () => {
  it('allows https anywhere and http on loopback only', () => {
    expect(isAllowedMcpUrl('https://mcp.context7.com/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://localhost:3920/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://127.0.0.1:8080/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://evil.example.com/mcp')).toBe(false);
    expect(isAllowedMcpUrl('ws://localhost:3920')).toBe(false);
    expect(isAllowedMcpUrl('not a url')).toBe(false);
  });
});

describe('argsForQuery', () => {
  it('maps the query onto a non-generic REQUIRED param (Context7 resolve-library-id)', () => {
    // The exact tool that errored: it wants `libraryName`, not `query`.
    const tool = { name: 'resolve-library-id', description: 'search for a library id', inputSchema: { type: 'object', properties: { libraryName: { type: 'string' } }, required: ['libraryName'] } };
    expect(argsForQuery(tool, 'react router')).toEqual({ libraryName: 'react router' });
  });

  it('prefers a generic search key when present', () => {
    const tool = { name: 'search', inputSchema: { properties: { query: {}, limit: {} } } };
    expect(argsForQuery(tool, 'quokkas')).toEqual({ query: 'quokkas' });
  });

  it('fills every required param so the call validates', () => {
    const tool = { name: 'find', inputSchema: { properties: { q: {}, index: {} }, required: ['q', 'index'] } };
    expect(argsForQuery(tool, 'x')).toEqual({ q: 'x', index: 'x' });
  });

  it('returns null when there is no fillable param (caller skips instead of erroring)', () => {
    expect(argsForQuery({ name: 'noargs', inputSchema: { type: 'object' } }, 'x')).toBeNull();
    expect(argsForQuery({ name: 'noschema' }, 'x')).toBeNull();
  });
});

const baseUrl = 'http://localhost:3920/mcp';

function createMockFetch(responseBody: string, headers: Record<string, string> = {}): any {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => headers[name] || null
    },
    text: async () => responseBody,
    json: async () => JSON.parse(responseBody),
  });
}

describe('McpConnection', () => {
  it('parses JSON response', async () => {
    const jsonResponse = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    global.fetch = createMockFetch(jsonResponse);
    const client = new McpConnection({ id: '1', name: 'Local', url: baseUrl, enabled: true });
    const tools = await client.listTools();
    expect(tools).toEqual([]);
  });

  it('parses SSE framed JSON response with single result', async () => {
    const sseResponse = `data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"toolA"}]}}
`;
    global.fetch = createMockFetch(sseResponse, { 'content-type': 'text/event-stream' });
    const client = new McpConnection({ id: '2', name: 'Local2', url: baseUrl, enabled: true });
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'toolA' }]);
  });

  it('returns last valid JSON-RPC message in SSE stream', async () => {
    const sseResponse = `data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"toolA"}]}}
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"toolB"}]}}
`;
    global.fetch = createMockFetch(sseResponse, { 'content-type': 'text/event-stream' });
    const client = new McpConnection({ id: '3', name: 'Local3', url: baseUrl, enabled: true });
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'toolB' }]);
  });

  it('ignores malformed SSE keep-alive frames', async () => {
    const sseResponse = `data: keep-alive\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"toolA"}]}}
`;
    global.fetch = createMockFetch(sseResponse, { 'content-type': 'text/event-stream' });
    const client = new McpConnection({ id: '4', name: 'Local4', url: baseUrl, enabled: true });
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'toolA' }]);
  });

  it('throws on non-ok response in listTools', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = new McpConnection({ id: '5', name: 'FailClient', url: baseUrl, enabled: true });
    await expect(client.listTools()).rejects.toThrow();
  });

  it('throws on isError result in callTool', async () => {
    const errResponse = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ text: 'Failed' }] } });
    global.fetch = createMockFetch(errResponse);
    const client = new McpConnection({ id: '6', name: 'ErrClient', url: baseUrl, enabled: true });
    await expect(client.callTool('badTool', {})).rejects.toThrow(/Failed/);
  });

  it('callTool returns concatenated text content', async () => {
    const successResponse = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
      { type: 'other', text: 'Skip' }
    ] } });
    global.fetch = createMockFetch(successResponse);
    const client = new McpConnection({ id: '7', name: 'GoodClient', url: baseUrl, enabled: true });
    const output = await client.callTool('goodTool', {});
    expect(output).toBe('Hello\n\nWorld');
  });

  it('isSearchLikeTool detects search-like tools', () => {
    expect(isSearchLikeTool({ name: 'search-db' })).toBe(true);
    expect(isSearchLikeTool({ name: 'lookup' })).toBe(true);
    expect(isSearchLikeTool({ name: 'findStuff', description: 'magic find' })).toBe(true);
    expect(isSearchLikeTool({ name: 'delete' })).toBe(false);
  });

  it('topicArgFor picks topic argument key', () => {
    expect(topicArgFor({ name: 't1', inputSchema: { properties: { q: {} } } })).toEqual({ q: '' });
    expect(topicArgFor({ name: 't2', inputSchema: { properties: { search: {} } } })).toEqual({ search: '' });
    expect(topicArgFor({ name: 't3', inputSchema: { properties: {} } })).toEqual({ query: '' });
  });
});
