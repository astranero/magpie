import { describe, it, expect } from 'vitest';
import { verifyFaithfulness, claimBefore } from '../faithfulness';

describe('claimBefore', () => {
  it('extracts the sentence preceding an anchor, stripping other anchors', () => {
    const t = 'First fact [a.s1.p1]. LLMs cut tokens by 66% [b.s2.p3][c.s0.p0].';
    const pos = t.indexOf('[b.s2.p3]');
    expect(claimBefore(t, pos)).toBe('LLMs cut tokens by 66%');
  });
});

describe('verifyFaithfulness', () => {
  const chunks: Record<string, string> = {
    'a.s1.p1': 'The sky is blue during clear daytime conditions.',
    'b.s2.p3': 'Benchmarks show a 66% reduction in token usage with structured prompting.',
    'c.s0.p0': 'A recipe for banana bread requires flour, sugar and ripe bananas.',
  };
  const getChunkText = async (a: string) => chunks[a] ?? null;

  it('drops a citation whose chunk does not support the claim', async () => {
    // Rerank: high for the on-topic chunk, low for the off-topic banana one.
    const rerank = async (_claim: string, evidences: string[]) =>
      evidences.map(e => (e.includes('banana') ? 0.02 : 0.9));

    const src = 'Structured prompting cuts token usage by 66% [b.s2.p3][c.s0.p0].';
    const r = await verifyFaithfulness(src, { rerank, getChunkText });

    expect(r.total).toBe(2);
    expect(r.dropped).toBe(1);
    expect(r.verified).toBe(1);
    expect(r.text).toContain('[b.s2.p3]');
    expect(r.text).not.toContain('[c.s0.p0]'); // the banana citation removed
  });

  it('keeps everything when all citations are supported', async () => {
    const rerank = async (_c: string, evidences: string[]) => evidences.map(() => 0.8);
    const src = 'A supported claim [a.s1.p1].';
    const r = await verifyFaithfulness(src, { rerank, getChunkText });
    expect(r.dropped).toBe(0);
    expect(r.text).toBe(src);
  });

  it('no-ops on text without anchors', async () => {
    const rerank = async () => [] as number[];
    const src = 'Plain prose with a [1] footnote but no dotted anchors.';
    const r = await verifyFaithfulness(src, { rerank, getChunkText });
    expect(r).toEqual({ text: src, total: 0, verified: 0, dropped: 0 });
  });

  it('leaves a citation alone when its chunk cannot be resolved', async () => {
    const rerank = async (_c: string, evidences: string[]) => evidences.map(() => 0.01);
    const src = 'Claim about a missing source [z.s9.p9].';
    const r = await verifyFaithfulness(src, { rerank, getChunkText });
    expect(r.total).toBe(0); // unresolved → not counted, not dropped
    expect(r.text).toBe(src);
  });

  it('does not drop on reranker failure', async () => {
    const rerank = async () => { throw new Error('offscreen down'); };
    const src = 'Claim [a.s1.p1].';
    const r = await verifyFaithfulness(src, { rerank, getChunkText });
    expect(r.dropped).toBe(0);
    expect(r.text).toBe(src);
  });
});
