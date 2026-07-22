import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockReflectOnStage: vi.fn(),
  mockSynthesizeSectionedPaper: vi.fn(async () => 'Final synthesized report sectioned'),
  mockEvaluateAndRefine: vi.fn(async (_, text) => text),
}));

// 1. Mock Global Chrome API before any imports run
global.chrome = {
  runtime: {
    sendMessage: vi.fn(async (msg) => {
      if (msg.action === 'OFFSCREEN_PARSE_HTML') {
        return { ok: true, markdown: 'Sample content', title: 'Test Page', wordCount: 2 };
      }
      if (msg.action === 'OFFSCREEN_GET_EMBEDDINGS') {
        return { ok: true, embeddings: [new Array(384).fill(0.1)] };
      }
      if (msg.action === 'OFFSCREEN_RERANK') {
        return { ok: true, scores: (msg.passages || []).map(() => 1.0) };
      }
      return { ok: true };
    }),
    reload: vi.fn(),
  },
  offscreen: {
    hasDocument: vi.fn(async () => true),
    createDocument: vi.fn(),
  },
} as any;

// Mock database and vector store modules using correct paths relative to this test file
vi.mock('../db', () => ({
  saveDocument: vi.fn(async () => ({ id: 'doc1', chunks: [], isDuplicate: false })),
  linkDocumentToProject: vi.fn(async () => {}),
  listDocuments: vi.fn(async () => []),
  getChunksForDocs: vi.fn(async () => []),
  getChunkByAnchor: vi.fn(async () => null),
  indexResearchDoc: vi.fn(async () => 'stageDoc1'),
}));

vi.mock('../vector-store', () => ({
  addChunksToVectorStore: vi.fn(async () => {}),
  searchSessionChunks: vi.fn(async () => [
    { id: 'chunk1', docId: 'doc1', anchorId: 'doc1.s1.p1', heading: 'Section 1', text: 'Some text', embedding: [] }
  ]),
  resetSessionIndex: vi.fn(),
  ensureProjectIndexed: vi.fn(async () => {}),
}));

vi.mock('../research-store', () => ({
  getJob: vi.fn(async () => null),
  updateJob: vi.fn(async () => {}),
  getPage: vi.fn(async () => null),
  savePage: vi.fn(async () => {}),
  listPages: vi.fn(async () => []),
}));

vi.mock('../pdf-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf-parser')>();
  return {
    ...actual,
    recreateOffscreen: vi.fn(async () => {}),
    recycleOffscreenWorker: vi.fn(async () => {}),
    pdfUrlToBody: vi.fn(async () => ''),
  };
});

vi.mock('../quality-gate', () => ({
  checkContentQuality: vi.fn(() => ({ pass: true })),
  extractDoi: vi.fn(() => null),
}));

vi.mock('../search-providers', () => ({
  searchWithProviders: vi.fn(async () => [
    { url: 'https://ex.com/result', title: 'Mock Result', snippet: 'Mock snippet content' }
  ]),
  getSearchApiKeys: vi.fn(async () => ({})),
  jinaWebSearch: vi.fn(),
}));

// Mock fetch globally
global.fetch = vi.fn(async () => {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => '<html><title>Test Page</title><body>Sample content</body></html>',
    json: async () => ({}),
  } as any;
});

vi.mock('../../background/deep-researcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../background/deep-researcher')>();
  return {
    ...actual,
    reflectOnStage: mocks.mockReflectOnStage,
    synthesizeSectionedPaper: mocks.mockSynthesizeSectionedPaper,
    evaluateAndRefine: mocks.mockEvaluateAndRefine,
  };
});

import { runDeepResearch } from '../../background/deep-researcher';
import { getJob } from '../research-store';

describe('Dynamic Stop-and-Pivot Deep Research Loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getJob).mockResolvedValue(null);
  });

  it('stops early when all outline sections are adequate or rich', async () => {
    const onProgress = vi.fn();
    
    // We mock the llm parameter (llmChatFn) to return appropriate outlines for reflection
    const llm = vi.fn(async (sys: string) => {
      if (sys.includes('research coordinator')) {
        return JSON.stringify({
          outline: {
            sections: [
              { id: 's1', heading: 'Section 1', goal: 'g', keyTerms: [], evidenceNotes: ['notes [doc1.s1.p1]'], status: 'adequate' },
              { id: 's2', heading: 'Section 2', goal: 'g', keyTerms: [], evidenceNotes: ['notes [doc1.s2.p1]'], status: 'rich' },
            ],
          },
          handoff: { establishedFacts: [], openGaps: [], contradictions: [], focusNext: 'done' },
          queries: ['query1'],
        });
      }
      if (sys.includes('JSON') || sys.includes('Return ONLY a JSON array')) {
        return '["q1", "q2"]';
      }
      return 'llm response';
    });

    const result = await runDeepResearch('project1', 'my topic', llm, onProgress, undefined, 'deep');

    // Expected early termination:
    // It should stop at Stage 1 and not proceed to Stage 2 (or more).
    expect(llm).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('[DYNAMIC STOP]'));
    expect(result.synthesis).toBe('llm response');
  }, 10000); // 10s timeout

  it('pivots queries when contradictions are detected', async () => {
    const onProgress = vi.fn();
    let reflectCalls = 0;
    
    const llm = vi.fn(async (sys: string) => {
      if (sys.includes('research coordinator')) {
        reflectCalls++;
        if (reflectCalls === 1) {
          return JSON.stringify({
            outline: {
              sections: [
                { id: 's1', heading: 'Section 1', goal: 'g', keyTerms: [], evidenceNotes: [], status: 'thin' },
              ],
            },
            handoff: {
              establishedFacts: [],
              openGaps: [],
              contradictions: ['Source A says 10% but Source B says 50%'],
              focusNext: 'resolve conflict',
            },
            queries: ['normal query'],
          });
        } else {
          // Stage 2: Stop early
          return JSON.stringify({
            outline: {
              sections: [
                { id: 's1', heading: 'Section 1', goal: 'g', keyTerms: [], evidenceNotes: [], status: 'adequate' },
              ],
            },
            handoff: { establishedFacts: [], openGaps: [], contradictions: [], focusNext: 'done' },
            queries: [],
          });
        }
      }
      if (sys.includes('JSON') || sys.includes('Return ONLY a JSON array')) {
        return '["q1", "q2"]';
      }
      return 'llm response';
    });

    await runDeepResearch('project1', 'my topic', llm, onProgress, undefined, 'deep');

    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('[DYNAMIC PIVOT]'));
  }, 15000); // 15s timeout
});
