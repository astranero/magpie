import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchSessionChunks } from '../vector-store';
import { sendToOffscreen } from '../offscreen-client';

// Mock offscreen client
vi.mock('../offscreen-client', () => ({
  sendToOffscreen: vi.fn(),
}));

// Mock db calls that ensureProjectIndexed uses
vi.mock('../db', () => ({
  listDocuments: vi.fn(async () => []),
  getChunksForDocs: vi.fn(async () => []),
}));

describe('HyDE Query Expansion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls llmChatFn and uses the generated hypothetical document for embedding when hyde is enabled', async () => {
    const mockEmbeddings = [new Array(384).fill(0.1)];
    vi.mocked(sendToOffscreen).mockResolvedValue({ ok: true, embeddings: mockEmbeddings });

    const llmChatFn = vi.fn(async (sys: string, user: string) => {
      expect(sys).toContain('hypothetical paragraph');
      expect(user).toContain('Query: what is RAG?');
      return 'Hypothetical response about RAG';
    });

    await searchSessionChunks('test-session', 'what is RAG?', 5, [], {
      hyde: true,
      llmChatFn,
    });

    expect(llmChatFn).toHaveBeenCalledTimes(1);
    expect(sendToOffscreen).toHaveBeenCalledWith({
      action: 'OFFSCREEN_GET_EMBEDDINGS',
      texts: ['Hypothetical response about RAG'],
    }, undefined, { priority: false });
  });

  it('does not call llmChatFn when hyde is disabled', async () => {
    const mockEmbeddings = [new Array(384).fill(0.1)];
    vi.mocked(sendToOffscreen).mockResolvedValue({ ok: true, embeddings: mockEmbeddings });

    const llmChatFn = vi.fn();

    await searchSessionChunks('test-session', 'what is RAG?', 5, [], {
      hyde: false,
      llmChatFn,
    });

    expect(llmChatFn).not.toHaveBeenCalled();
    expect(sendToOffscreen).toHaveBeenCalledWith({
      action: 'OFFSCREEN_GET_EMBEDDINGS',
      texts: ['what is RAG?'],
    }, undefined, { priority: false });
  });

  it('falls back to original query when llmChatFn throws', async () => {
    const mockEmbeddings = [new Array(384).fill(0.1)];
    vi.mocked(sendToOffscreen).mockResolvedValue({ ok: true, embeddings: mockEmbeddings });

    const llmChatFn = vi.fn().mockRejectedValue(new Error('LLM Error'));

    await searchSessionChunks('test-session', 'what is RAG?', 5, [], {
      hyde: true,
      llmChatFn,
    });

    expect(llmChatFn).toHaveBeenCalledTimes(1);
    expect(sendToOffscreen).toHaveBeenCalledWith({
      action: 'OFFSCREEN_GET_EMBEDDINGS',
      texts: ['what is RAG?'],
    }, undefined, { priority: false });
  });
});
