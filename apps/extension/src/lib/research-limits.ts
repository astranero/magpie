// ─────────────────────────────────────────────
// Research depth tiers + context-aware synthesis budget
// ─────────────────────────────────────────────
// One knob ("Research depth" in Settings) scales every discovery pipeline.
// The synthesis context is budgeted from the model's context window rather
// than a fixed chunk count — feeding 100 chunks to an 8k-context model just
// truncates silently and *worsens* the report.

export type ResearchDepth = 'standard' | 'deep' | 'exhaustive';

export interface ResearchLimits {
  /** Web URLs kept per search query */
  urlsPerQuery: number;
  /** Web queries executed in deep mode */
  webQueries: number;
  /** Semantic Scholar results per query */
  s2Limit: number;
  /** HuggingFace papers per query */
  hfLimit: number;
  /** CrossRef rows per query (0 = skip CrossRef) */
  crossrefRows: number;
  /** Google News articles */
  newsMax: number;
  /** Retrieval per angle (topic + each sub-question) in deep mode */
  chunksPerAngle: number;
  /** Total retrieval pool cap in deep mode */
  chunkPoolCap: number;
  /** Retrieval cap for quick mode */
  quickChunks: number;
  /** Gather→analyze→re-query stages in deep mode (Gemini-style iterations) */
  rounds: number;
  /** Hard cap on total sources indexed in one research run (prevents 400+ paper ONNX crashes) */
  totalSourcesCap: number;
}

export const RESEARCH_LIMITS: Record<ResearchDepth, ResearchLimits> = {
  standard:  { urlsPerQuery: 6,  webQueries: 5, s2Limit: 8,  hfLimit: 8,  crossrefRows: 0,  newsMax: 6,  chunksPerAngle: 15, chunkPoolCap: 120, quickChunks: 40, rounds: 2, totalSourcesCap: 40  },
  deep:      { urlsPerQuery: 10, webQueries: 7, s2Limit: 20, hfLimit: 15, crossrefRows: 10, newsMax: 10, chunksPerAngle: 20, chunkPoolCap: 200, quickChunks: 60, rounds: 8, totalSourcesCap: 160 },
  exhaustive:{ urlsPerQuery: 12, webQueries: 8, s2Limit: 30, hfLimit: 20, crossrefRows: 20, newsMax: 12, chunksPerAngle: 25, chunkPoolCap: 300, quickChunks: 80, rounds: 10, totalSourcesCap: 240 },
};

export const DEFAULT_CONTEXT_TOKENS = 32768;

export async function getResearchDepth(): Promise<ResearchDepth> {
  try {
    const s = await chrome.storage.local.get(['researchDepth']);
    const d = s.researchDepth as ResearchDepth;
    return d === 'deep' || d === 'exhaustive' ? d : 'standard';
  } catch {
    return 'standard';
  }
}

export async function getResearchLimits(): Promise<ResearchLimits> {
  return RESEARCH_LIMITS[await getResearchDepth()];
}

/**
 * Character budget for synthesis context, derived from the model's context
 * window. ~3.2 chars/token for English prose; 55% of the window is left for
 * excerpts, the rest for instructions, sub-questions, and the report itself.
 */
export function synthesisCharBudget(contextTokens: number): number {
  const tokens = Number.isFinite(contextTokens) && contextTokens >= 2048 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  return Math.floor(tokens * 3.2 * 0.55);
}

export async function getSynthesisCharBudget(): Promise<number> {
  try {
    const s = await chrome.storage.local.get(['contextTokens']);
    return synthesisCharBudget(Number(s.contextTokens));
  } catch {
    return synthesisCharBudget(DEFAULT_CONTEXT_TOKENS);
  }
}

export type SourceQuality = 'high' | 'all';

/**
 * 'high': only reputable domains (academic, standards bodies, quality press)
 * and citation-backed papers reach the report. 'all': everything that passes
 * the content-quality gate, including blogs/forums — broader but noisier.
 */
export async function getSourceQuality(): Promise<SourceQuality> {
  try {
    const s = await chrome.storage.local.get(['sourceQuality']);
    return s.sourceQuality === 'high' ? 'high' : 'all';
  } catch {
    return 'all';
  }
}

/**
 * 'abstract': index title + abstract only — fast, stable, ~2 chunks/paper.
 * 'full': fetch and index full PDF text where available — richer but slower
 *         and can cause ONNX WASM crashes on very long papers.
 */
export type AcademicDepth = 'abstract' | 'full';

export async function getAcademicDepth(): Promise<AcademicDepth> {
  try {
    const s = await chrome.storage.local.get(['academicDepth']);
    return s.academicDepth === 'abstract' ? 'abstract' : 'full';
  } catch {
    return 'full';
  }
}

// ── Report length preference ─────────────────────────────────────────────────
// Founder dogfooding wanted 1800-3000-word reports; other users may want the
// opposite. A dial beats an assumption (research-synthesis finding). Each spec
// feeds the synthesis prompts' word targets — depth scaling stays in
// RESEARCH_LIMITS; this only shapes the WRITTEN output.
export type ReportLength = 'concise' | 'standard' | 'comprehensive';

export interface ReportLengthSpec {
  /** Final report target, prose ("1800–3000"). */
  total: string;
  /** Per-section target for sectioned synthesis. */
  sectionWords: string;
  /** Quick-mode (/research) report target. */
  quick: string;
  /** Outline section-count guidance. */
  sections: string;
}

export const REPORT_LENGTH_SPECS: Record<ReportLength, ReportLengthSpec> = {
  concise:       { total: '900–1500',  sectionWords: '150–350', quick: '500–900',   sections: '3-5'  },
  standard:      { total: '1800–3000', sectionWords: '300–700', quick: '800–1500',  sections: '4-8'  },
  comprehensive: { total: '2800–4500', sectionWords: '500–900', quick: '1200–2000', sections: '5-10' },
};

export async function getReportLength(): Promise<ReportLength> {
  try {
    const s = await chrome.storage.local.get(['reportLength']);
    const v = s.reportLength as ReportLength;
    return v === 'concise' || v === 'comprehensive' ? v : 'standard';
  } catch {
    return 'standard';
  }
}

export async function getReportLengthSpec(): Promise<ReportLengthSpec> {
  return REPORT_LENGTH_SPECS[await getReportLength()];
}
