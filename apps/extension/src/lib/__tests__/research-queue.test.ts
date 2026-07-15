import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueResearch, dequeueResearch, getResearchQueue,
  removeQueuedResearch, clearResearchQueue,
} from '../research-queue';

let store: Map<string, any>;

beforeEach(() => {
  store = new Map();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: (keys: string[]) => {
          const out: Record<string, any> = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (store.has(k)) out[k] = store.get(k); });
          return Promise.resolve(out);
        },
        set: (items: Record<string, any>) => { Object.entries(items).forEach(([k, v]) => store.set(k, v)); return Promise.resolve(); },
      },
    },
  };
});
afterEach(() => { (globalThis as any).chrome = undefined; });

const item = (topic: string) => ({ projectId: 'p', chatId: 'c', topic, mode: 'deep' as const });

describe('research-queue', () => {
  it('enqueues FIFO and returns 1-based position', async () => {
    expect(await enqueueResearch(item('a'))).toBe(1);
    expect(await enqueueResearch(item('b'))).toBe(2);
    expect((await getResearchQueue()).map(x => x.topic)).toEqual(['a', 'b']);
  });

  it('dequeues oldest first, then null when empty', async () => {
    await enqueueResearch(item('a'));
    await enqueueResearch(item('b'));
    expect((await dequeueResearch())?.topic).toBe('a');
    expect((await dequeueResearch())?.topic).toBe('b');
    expect(await dequeueResearch()).toBeNull();
  });

  it('removes a specific queued run by id', async () => {
    await enqueueResearch(item('a'));
    await enqueueResearch(item('b'));
    const q = await getResearchQueue();
    await removeQueuedResearch(q[0].id);
    expect((await getResearchQueue()).map(x => x.topic)).toEqual(['b']);
  });

  it('clears the whole queue', async () => {
    await enqueueResearch(item('a'));
    await clearResearchQueue();
    expect(await getResearchQueue()).toEqual([]);
  });

  it('sourceMode survives the enqueue → dequeue round trip (/academic stays papers-only when parked)', async () => {
    await enqueueResearch({ ...item('papers'), sourceMode: 'academic' });
    await enqueueResearch(item('plain'));
    expect((await dequeueResearch())?.sourceMode).toBe('academic');
    expect((await dequeueResearch())?.sourceMode).toBeUndefined();
  });

  it('empty queue reads as [] (no stored key)', async () => {
    expect(await getResearchQueue()).toEqual([]);
    expect(await dequeueResearch()).toBeNull();
  });
});
