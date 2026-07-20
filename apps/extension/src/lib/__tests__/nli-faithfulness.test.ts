import { describe, it, expect, vi } from 'vitest';
import { verifyFaithfulness } from '../faithfulness';

describe('Local NLI Factual Verification in verifyFaithfulness', () => {
  const chunks: Record<string, string> = {
    'a.s1.p1': 'The sky is blue during clear daytime conditions.',
    'b.s2.p3': 'Benchmarks show a 66% reduction in token usage with structured prompting.',
  };
  const getChunkText = async (a: string) => chunks[a] ?? null;

  it('keeps citations that have high entailment and low contradiction', async () => {
    const rerank = vi.fn(async (_c: string, evidences: string[]) => evidences.map(() => 2));
    const classifyNli = vi.fn(async (pairs) => pairs.map(() => ({
      entailment: 0.95,
      neutral: 0.04,
      contradiction: 0.01,
    })));

    const src = 'Structured prompting cuts token usage by 66% [b.s2.p3].';
    const r = await verifyFaithfulness(src, { rerank, classifyNli, getChunkText });

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(classifyNli).toHaveBeenCalledTimes(1);
    expect(classifyNli).toHaveBeenCalledWith([
      { premise: 'Benchmarks show a 66% reduction in token usage with structured prompting.', claim: 'Structured prompting cuts token usage by 66%' }
    ]);
    expect(r.total).toBe(1);
    expect(r.dropped).toBe(0);
    expect(r.verified).toBe(1);
    expect(r.text).toBe(src);
  });

  it('drops citations that fail entailment threshold (< 0.25)', async () => {
    const rerank = vi.fn(async (_c: string, evidences: string[]) => evidences.map(() => 2)); // Passes relevance (logit)
    const classifyNli = vi.fn(async () => [
      { entailment: 0.10, neutral: 0.85, contradiction: 0.05 } // Low entailment (neutral but doesn't support)
    ]);

    const src = 'Structured prompting cuts token usage by 66% [b.s2.p3].';
    const r = await verifyFaithfulness(src, { rerank, classifyNli, getChunkText });

    expect(r.dropped).toBe(1);
    expect(r.verified).toBe(0);
    expect(r.text).not.toContain('[b.s2.p3]');
  });

  it('drops citations that exceed contradiction threshold (> 0.40)', async () => {
    const rerank = vi.fn(async (_c: string, evidences: string[]) => evidences.map(() => 2)); // Passes relevance (logit)
    const classifyNli = vi.fn(async () => [
      { entailment: 0.10, neutral: 0.10, contradiction: 0.80 } // High contradiction
    ]);

    const src = 'Structured prompting cuts token usage by 66% [b.s2.p3].';
    const r = await verifyFaithfulness(src, { rerank, classifyNli, getChunkText });

    expect(r.dropped).toBe(1);
    expect(r.verified).toBe(0);
    expect(r.text).not.toContain('[b.s2.p3]');
  });

  it('does not drop citations if relevance check fails before NLI is reached', async () => {
    const rerank = vi.fn(async (_c: string, evidences: string[]) => evidences.map(() => -6)); // Fails relevance (rel < -2, logit)
    const classifyNli = vi.fn(async () => [
      { entailment: 0.95, neutral: 0.04, contradiction: 0.01 }
    ]);

    const src = 'Structured prompting cuts token usage by 66% [b.s2.p3].';
    const r = await verifyFaithfulness(src, { rerank, classifyNli, getChunkText });

    expect(r.dropped).toBe(1); // Dropped by relevance
    expect(classifyNli).not.toHaveBeenCalled(); // NLI not reached because relevance filtered it out
  });

  it('falls back to relevance results if NLI throws an error', async () => {
    const rerank = vi.fn(async (_c: string, evidences: string[]) => evidences.map(() => 2)); // Passes relevance (logit)
    const classifyNli = vi.fn(async () => { throw new Error('NLI classifier error'); });

    const src = 'Structured prompting cuts token usage by 66% [b.s2.p3].';
    const r = await verifyFaithfulness(src, { rerank, classifyNli, getChunkText });

    expect(r.dropped).toBe(0); // Kept because of fallback (passed relevance)
    expect(r.verified).toBe(1);
  });
});
