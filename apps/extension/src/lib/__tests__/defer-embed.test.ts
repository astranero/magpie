// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic "embeddings": one 384-dim vector per requested text. The value
// distinguishes embedded (non-zero) from vector-less chunks in assertions.
vi.mock('../offscreen-client', () => ({
  sendToOffscreen: vi.fn(async (msg: any) => {
    if (msg?.action === 'OFFSCREEN_GET_EMBEDDINGS') {
      return { ok: true, embeddings: (msg.texts as string[]).map(() => new Array(384).fill(0.5)) };
    }
    return { ok: false };
  }),
}));

import {
  saveDocument, embedChunksForDoc, resumePendingEmbeds,
  getChunksForDoc, listDocuments, type Chunk,
} from '../db';

let uid = 0;
function chunk(text: string): Omit<Chunk, 'id' | 'docId'> {
  const i = uid++;
  return {
    chunkIndex: i, text, heading: 'H', sectionPath: 'H',
    paragraphIndex: i, anchorId: `d0.s0.p${i}`, charStart: 0, charEnd: text.length,
  };
}

const doc = (url: string) => ({
  title: 'T', url, content: '# T\n\nbody', capturedAt: new Date().toISOString(),
  wordCount: 2, syncedToDrive: false,
});

describe('deferred embedding — fast capture then background backfill', () => {
  beforeEach(() => { uid = 0; });

  it('deferEmbed saves chunks vector-less and flags the doc pendingEmbed', async () => {
    const { id } = await saveDocument(doc('https://x.test/a'), [chunk('alpha'), chunk('beta')], { deferEmbed: true });
    const chunks = await getChunksForDoc(id);
    expect(chunks.length).toBe(2);
    expect(chunks.every(c => !c.embedding)).toBe(true); // no vectors yet

    const stored = (await listDocuments()).find(d => d.id === id)!;
    expect(stored.pendingEmbed).toBe(true);
  });

  it('embedChunksForDoc backfills vectors and clears the flag', async () => {
    const { id } = await saveDocument(doc('https://x.test/b'), [chunk('alpha'), chunk('beta')], { deferEmbed: true });
    const saved = await embedChunksForDoc(id);
    expect(saved.length).toBe(2);
    expect(saved.every(c => c.embedding?.length === 384)).toBe(true);

    const chunks = await getChunksForDoc(id);
    expect(chunks.every(c => c.embedding?.length === 384)).toBe(true);

    const stored = (await listDocuments()).find(d => d.id === id)!;
    expect(stored.pendingEmbed).toBeUndefined();
  });

  it('preserves the citation anchor prefix across the backfill', async () => {
    const { id } = await saveDocument(doc('https://x.test/c'), [chunk('alpha')], { deferEmbed: true });
    const before = (await getChunksForDoc(id))[0].anchorId;
    await embedChunksForDoc(id);
    const after = (await getChunksForDoc(id))[0].anchorId;
    // Same doc-short-id prefix + section/paragraph tail — citations must not break.
    expect(after.split('.')[0]).toBe(before.split('.')[0]);
    expect(after).toBe(before);
  });

  it('non-deferred saveDocument embeds inline (unchanged path)', async () => {
    const { id } = await saveDocument(doc('https://x.test/d'), [chunk('alpha')]);
    const chunks = await getChunksForDoc(id);
    expect(chunks[0].embedding?.length).toBe(384);
    const stored = (await listDocuments()).find(d => d.id === id)!;
    expect(stored.pendingEmbed).toBeUndefined();
  });

  it('resumePendingEmbeds finishes captures whose background embed was cut off', async () => {
    await saveDocument(doc('https://x.test/e'), [chunk('alpha')], { deferEmbed: true });
    await saveDocument(doc('https://x.test/f'), [chunk('beta')], { deferEmbed: true });
    const n = await resumePendingEmbeds();
    expect(n).toBeGreaterThanOrEqual(2);
    const stillPending = (await listDocuments()).filter(d => d.pendingEmbed);
    expect(stillPending.length).toBe(0);
  });
});
