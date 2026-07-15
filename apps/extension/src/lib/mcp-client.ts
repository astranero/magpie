// ─────────────────────────────────────────────
// MCP client — Streamable HTTP transport only
// ─────────────────────────────────────────────
// MV3 extensions cannot spawn processes or open raw TCP sockets, so stdio
// MCP servers are out of reach. Servers exposed over the MCP Streamable
// HTTP transport (a single POST endpoint, JSON or SSE responses) work fine
// through fetch. The user runs the server themselves and registers its URL
// in Settings; enabling a server is the permission grant — its tools may be
// invoked during research runs.

export interface McpServerConfig {
  id: string;
  name: string;
  /** Endpoint URL, e.g. http://localhost:3920/mcp */
  url: string;
  enabled: boolean;
  /** Optional bearer token, sent as Authorization: Bearer <token>. */
  authToken?: string;
  /** Shown in Settings to guide first-time setup (e.g. install + run commands). */
  setupHint?: string;
  /** GET endpoint to probe whether the server is running (e.g. /health). */
  healthUrl?: string;
}

/** MCP URL policy: https anywhere, http only to loopback hosts. */
export function isAllowedMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
    }
    return false;
  } catch {
    return false;
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-03-26';
const RPC_TIMEOUT_MS = 30000;

/** Parse a Streamable HTTP response body: plain JSON or SSE-framed JSON. */
async function parseRpcResponse(res: Response): Promise<any> {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    // Last data: frame carrying a JSON-RPC response wins
    let result: any = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && (msg.result !== undefined || msg.error !== undefined)) result = msg;
      } catch { /* keep-alives / partial frames */ }
    }
    return result;
  }
  return res.json();
}

export class McpConnection {
  
  static isSearchLikeTool(tool: McpTool): boolean {
    const hay = `${tool.name} ${tool.description || ''}`.toLowerCase();
    return /\b(search|query|lookup|retrieve|find|fetch)\b/.test(hay);
  }

  static topicArgFor(tool: McpTool): Record<string, unknown> {
    const props = Object.keys((tool.inputSchema as any)?.properties || {});
    const key = ['query', 'q', 'search', 'topic', 'text', 'prompt'].find(k => props.includes(k)) || props[0] || 'query';
    return { [key]: '' };
  }

  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(private config: McpServerConfig) {}

  private async rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    // URL policy: https, or http only to loopback (local dev servers). A plain
    // http remote would ship the research topic — and any bearer token — in
    // cleartext to an arbitrary host. Enforced at call time so it also covers
    // configs registered before this policy existed.
    if (!isAllowedMcpUrl(this.config.url)) {
      throw new Error(`MCP server ${this.config.name}: blocked URL (${this.config.url}) — use https://, or http:// only for localhost`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      };
      if (this.config.authToken) headers['Authorization'] = `Bearer ${this.config.authToken}`;
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

      const res = await fetch(this.config.url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params: params ?? {} })
      });
      if (!res.ok) throw new Error(`MCP server ${this.config.name}: HTTP ${res.status}`);

      const sid = res.headers.get('Mcp-Session-Id');
      if (sid) this.sessionId = sid;

      const msg = await parseRpcResponse(res);
      if (!msg) throw new Error(`MCP server ${this.config.name}: empty response`);
      if (msg.error) throw new Error(`MCP server ${this.config.name}: ${msg.error.message || 'RPC error'}`);
      return msg.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (this.config.authToken) headers['Authorization'] = `Bearer ${this.config.authToken}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method })
    }).catch(() => {});
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ai-research-assistant', version: '1.0.0' }
    });
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = await this.rpc('tools/list');
    return (result?.tools || []) as McpTool[];
  }

  /** Call a tool and return its text content joined as markdown. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result?.isError) {
      const err = (result.content || []).map((c: any) => c.text).filter(Boolean).join('\n');
      throw new Error(err || `Tool ${name} failed`);
    }
    return (result?.content || [])
      .filter((c: any) => c.type === 'text' && c.text)
      .map((c: any) => c.text)
      .join('\n\n');
  }
}

// ── Server registry (chrome.storage.local under `mcpServers`) ──

/**
 * Recommended MCPs seeded once into a fresh install. Kept minimal and
 * deterministic (the "standard library" principle) — only Streamable HTTP
 * servers work in a browser extension (no stdio). Includes both remote
 * hosted servers and local servers the user can run themselves.
 * Seeded DISABLED: present with one-click enable, so we never call
 * a third party without the user opting in (local-first).
 */
export const DEFAULT_MCP_SERVERS: McpServerConfig[] = [
  {
    id: 'default-context7',
    name: 'Context7 · live library docs',
    url: 'https://mcp.context7.com/mcp',
    enabled: false,   // opt-in: flip on in Config → MCP Servers
  },
  {
    id: 'default-biomcp',
    name: 'BioMCP · biomedical research (local)',
    url: 'http://localhost:8080/mcp',
    enabled: false,
    healthUrl: 'http://localhost:8080/health',
    setupHint: 'pip install biomcp-cli\nbiomcp serve-http --port 8080',
  },
];

/**
 * Bump this when new entries are added to DEFAULT_MCP_SERVERS. The seeding
 * logic re-runs for any user whose stored version is lower, adding only
 * servers whose URL isn't already present (so user removals are respected).
 */
const MCP_SEED_VERSION = 2;   // v1 = Context7, v2 = + BioMCP

export async function getMcpServers(): Promise<McpServerConfig[]> {
  try {
    const s = await chrome.storage.local.get(['mcpServers', 'mcpSeeded', 'mcpSeedVersion']);
    const existing: McpServerConfig[] = Array.isArray(s.mcpServers) ? s.mcpServers : [];
    const storedVersion: number = typeof s.mcpSeedVersion === 'number' ? s.mcpSeedVersion : (s.mcpSeeded ? 1 : 0);
    if (storedVersion < MCP_SEED_VERSION) {
      const haveUrls = new Set(existing.map(x => x.url));
      const merged = [...existing, ...DEFAULT_MCP_SERVERS.filter(d => !haveUrls.has(d.url))];
      await chrome.storage.local.set({ mcpServers: merged, mcpSeeded: true, mcpSeedVersion: MCP_SEED_VERSION });
      return merged;
    }
    return existing;
  } catch {
    return [];
  }
}

export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await chrome.storage.local.set({ mcpServers: servers });
}

/**
 * Heuristic: which of a server's tools looks like a topic search? Used by the
 * research pipeline to feed the research topic to appropriate tools only.
 */
export function isSearchLikeTool(tool: McpTool): boolean {
  const hay = `${tool.name} ${tool.description || ''}`.toLowerCase();
  return /\b(search|query|lookup|retrieve|find|fetch)\b/.test(hay);
}

/** Pick the input property to carry the topic: prefer query/q/search/topic/text. */
export function topicArgFor(tool: McpTool): Record<string, unknown> {
  const props = Object.keys((tool.inputSchema as any)?.properties || {});
  const key = ['query', 'q', 'search', 'topic', 'text', 'prompt'].find(k => props.includes(k)) || props[0] || 'query';
  return { [key]: '' };
}

/**
 * Build a full arguments object that feeds `query` to a search-like tool.
 * Robust to non-generic parameter names (e.g. Context7's resolve-library-id
 * wants `libraryName`, not `query` — passing `query` triggered a validation
 * error): prefer a known search key, else the tool's first REQUIRED param, else
 * its first param. Also fills any OTHER required params with the query so the
 * call validates. Returns null when the schema exposes no param we can fill —
 * callers skip the tool instead of sending a rejected call.
 */
export function argsForQuery(tool: McpTool, query: string): Record<string, unknown> | null {
  const schema = (tool.inputSchema as any) || {};
  const props = Object.keys(schema.properties || {});
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const preferred = ['query', 'q', 'search', 'searchquery', 'topic', 'text', 'prompt', 'keyword', 'term', 'question', 'libraryname', 'name'];
  const key = props.find(p => preferred.includes(p.toLowerCase())) || required[0] || props[0];
  if (!key) return null;
  const args: Record<string, unknown> = { [key]: query };
  for (const r of required) if (!(r in args)) args[r] = query;
  return args;
}
