import { describe, it, expect, afterEach, vi } from 'vitest';
import { pickOllamaModel, detectOllama, autoConfigureProvider, OLLAMA_OPENAI_URL, BUILTIN_GEMINI_SENTINEL } from '../provider-detect';

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).chrome = undefined;
  (globalThis as any).LanguageModel = undefined;
});

describe('pickOllamaModel', () => {
  it('prefers a general instruct model over embedders', () => {
    expect(pickOllamaModel(['nomic-embed-text:latest', 'llama3.2:3b', 'all-minilm:l6'])).toBe('llama3.2:3b');
  });
  it('falls back to first non-embedder, then first anything, then empty', () => {
    expect(pickOllamaModel(['custommodel:7b'])).toBe('custommodel:7b');
    expect(pickOllamaModel(['nomic-embed-text'])).toBe('nomic-embed-text');
    expect(pickOllamaModel([])).toBe('');
  });
});

describe('detectOllama', () => {
  it('reports available + model names on a healthy /api/tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen2:7b' }] }),
    }));
    expect(await detectOllama()).toEqual({ available: true, models: ['llama3.2:3b', 'qwen2:7b'] });
  });
  it('unavailable on network failure — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await detectOllama()).toEqual({ available: false, models: [] });
  });
});

describe('autoConfigureProvider (BYOK is absolute)', () => {
  const mockChrome = (stored: Record<string, unknown>) => {
    const store = { ...stored };
    (globalThis as any).chrome = { storage: { local: {
      get: async () => store,
      set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
    } } };
    return store;
  };

  it('NEVER touches an existing endpoint or key', async () => {
    const store = mockChrome({ customUrl: 'https://openrouter.ai/api/v1', customKey: '' });
    expect(await autoConfigureProvider()).toBeNull();
    expect(store.customUrl).toBe('https://openrouter.ai/api/v1');

    mockChrome({ customUrl: '', customKey: 'sk-something' });
    expect(await autoConfigureProvider()).toBeNull();
  });

  it('adopts Ollama when nothing configured and Ollama has models', async () => {
    const store = mockChrome({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:3b' }] }) }));
    expect(await autoConfigureProvider()).toBe('ollama');
    expect(store.customUrl).toBe(OLLAMA_OPENAI_URL);
    expect(store.customModel).toBe('llama3.2:3b');
  });

  it('falls back to built-in Gemini when no Ollama', async () => {
    const store = mockChrome({});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    (globalThis as any).LanguageModel = { availability: async () => 'available', create: async () => ({}) };
    expect(await autoConfigureProvider()).toBe('builtin-gemini');
    expect(store.customUrl).toBe(BUILTIN_GEMINI_SENTINEL);
  });

  it('configures nothing when nothing is detected', async () => {
    const store = mockChrome({});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await autoConfigureProvider()).toBeNull();
    expect(store.customUrl).toBeUndefined();
  });
});
