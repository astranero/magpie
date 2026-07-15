import { describe, it, expect, beforeEach, vi } from 'vitest';

function mockStorage(initial: Record<string, any> = {}) {
  const data = { ...initial };
  (globalThis as any).chrome = {
    storage: { local: {
      get: vi.fn(async (keys: string[]) => { const o: any = {}; for (const k of keys) o[k] = data[k]; return o; }),
      set: vi.fn(async (patch: any) => { Object.assign(data, patch); }),
    } }
  };
  return data;
}

describe('MCP default seeding', () => {
  beforeEach(() => { vi.resetModules(); });

  it('seeds Context7 + BioMCP into a fresh install (present, disabled)', async () => {
    const data = mockStorage({});
    const { getMcpServers } = await import('../mcp-client');
    const servers = await getMcpServers();
    const ctx7 = servers.find(s => s.url === 'https://mcp.context7.com/mcp');
    const bio = servers.find(s => s.url === 'http://localhost:8080/mcp');
    expect(ctx7).toBeTruthy();
    expect(ctx7!.enabled).toBe(false);
    expect(bio).toBeTruthy();
    expect(bio!.enabled).toBe(false);
    expect(bio!.healthUrl).toBe('http://localhost:8080/health');
    expect(bio!.setupHint).toBeTruthy();
    expect(data.mcpSeeded).toBe(true);
    expect(data.mcpSeedVersion).toBeGreaterThanOrEqual(2);
  });

  it('does NOT re-seed after the user removes servers (at current version)', async () => {
    mockStorage({ mcpServers: [], mcpSeeded: true, mcpSeedVersion: 99 });
    const { getMcpServers } = await import('../mcp-client');
    const servers = await getMcpServers();
    expect(servers).toEqual([]);              // stays removed
  });

  it('upgrades v1 users (had only Context7) to get BioMCP', async () => {
    const ctx7 = { id: 'default-context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', enabled: true };
    const data = mockStorage({ mcpServers: [ctx7], mcpSeeded: true });   // v1 user: has mcpSeeded but no mcpSeedVersion
    const { getMcpServers } = await import('../mcp-client');
    const servers = await getMcpServers();
    expect(servers.length).toBe(2);           // Context7 + BioMCP
    expect(servers.find(s => s.url === 'http://localhost:8080/mcp')).toBeTruthy();
    expect(data.mcpSeedVersion).toBeGreaterThanOrEqual(2);
    // Context7 stays enabled (user's choice preserved)
    expect(servers.find(s => s.url === 'https://mcp.context7.com/mcp')!.enabled).toBe(true);
  });

  it('does NOT duplicate BioMCP if user already added it manually', async () => {
    const manual = { id: 'my-bio', name: 'My BioMCP', url: 'http://localhost:8080/mcp', enabled: true };
    mockStorage({ mcpServers: [manual], mcpSeeded: true });   // v1 user who added BioMCP manually
    const { getMcpServers } = await import('../mcp-client');
    const servers = await getMcpServers();
    const bioEntries = servers.filter(s => s.url === 'http://localhost:8080/mcp');
    expect(bioEntries.length).toBe(1);        // no duplicate
    expect(bioEntries[0].name).toBe('My BioMCP');  // user's name preserved
  });
});
