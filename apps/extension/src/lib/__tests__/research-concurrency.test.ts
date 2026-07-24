// ─────────────────────────────────────────────
// Concurrency regression guard: research runs serialize
// ─────────────────────────────────────────────
// The research JOB checkpoint is a singleton — two runs at once would stomp each
// other's resume state (and double the peak memory of the shared offscreen
// process). service-worker.ts guarantees serialization with a persisted FIFO
// (research-queue) drained one-at-a-time behind a `queueDraining` latch. These
// tests reproduce that drain contract against the real queue and assert the two
// invariants that matter: FIFO order, and never more than one run active.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { enqueueResearch, dequeueResearch, getResearchQueue } from '../research-queue';

let store: Map<string, any>;
beforeEach(() => {
  store = new Map();
  (globalThis as any).chrome = {
    storage: { local: {
      get: (keys: string[]) => { const o: Record<string, any> = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (store.has(k)) o[k] = store.get(k); }); return Promise.resolve(o); },
      set: (items: Record<string, any>) => { Object.entries(items).forEach(([k, v]) => store.set(k, v)); return Promise.resolve(); },
    } },
  };
});
afterEach(() => { (globalThis as any).chrome = undefined; });

const item = (topic: string) => ({ projectId: 'p', chatId: 'c', topic, mode: 'deep' as const });
const tick = () => new Promise(r => setTimeout(r, 0));

// Faithful port of drainResearchQueue's loop: a single latch, sequential
// dequeue→run→repeat. `run` reports concurrency into shared counters.
function makeDrainer() {
  let draining = false;
  let active = 0, maxActive = 0;
  const ran: string[] = [];
  async function drain() {
    if (draining) return;          // the `queueDraining` latch
    draining = true;
    try {
      let next;
      while ((next = await dequeueResearch())) {
        active++; maxActive = Math.max(maxActive, active);
        await tick(); await tick();  // simulate a run doing async work
        ran.push(next.topic);
        active--;
      }
    } finally { draining = false; }
  }
  return { drain, get ran() { return ran; }, get maxActive() { return maxActive; } };
}

describe('research serialization', () => {
  it('drains the whole queue in FIFO order, one run at a time', async () => {
    await enqueueResearch(item('A'));
    await enqueueResearch(item('B'));
    await enqueueResearch(item('C'));
    const d = makeDrainer();
    await d.drain();
    expect(d.ran).toEqual(['A', 'B', 'C']);
    expect(d.maxActive).toBe(1);
    expect(await getResearchQueue()).toEqual([]);
  });

  it('two concurrent drain triggers never double-run an item (latch holds)', async () => {
    await enqueueResearch(item('A'));
    await enqueueResearch(item('B'));
    const d = makeDrainer();
    // Fire two drains at once — a second START message arriving mid-run.
    await Promise.all([d.drain(), d.drain()]);
    expect(d.ran).toEqual(['A', 'B']);        // each exactly once, in order
    expect(d.maxActive).toBe(1);              // never two active
  });

  it('a run enqueued DURING draining is still picked up before the loop exits', async () => {
    await enqueueResearch(item('A'));
    const d = makeDrainer();
    const p = d.drain();
    await tick();                              // let the drainer start on A
    await enqueueResearch(item('B'));          // queued mid-run
    await p;
    expect(d.ran).toEqual(['A', 'B']);
  });
});
