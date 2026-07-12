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

  it('seeds Context7 once into a fresh install (present, disabled)', async () => {
    const data = mockStorage({});
    const { getMcpServers } = await import('../mcp-client');
    const servers = await getMcpServers();
    const ctx7 = servers.find(s => s.url === 'https://mcp.context7.com/mcp');
    expect(ctx7).toBeTruthy();
    expect(ctx7!.enabled).toBe(false);       // opt-in
    expect(data.mcpSeeded).toBe(true);
  });

  it('does NOT re-seed after the user removes it', async () => {
    mockStorage({ mcpServers: [], mcpSeeded: true });   // already seeded, user cleared list
    const { getMcpServers } = await import('../mcp-client');
    const servers = await getMcpServers();
    expect(servers).toEqual([]);              // stays removed
  });
});
