// ─────────────────────────────────────────────
// Research queue — sequential batching for deep research
// ─────────────────────────────────────────────
// The research JOB checkpoint is a singleton (one JOB_KEY): only one run can be
// active at a time, and a second start would stomp the first's resume state. So a
// second /deepresearch used to just error ("already active"). Instead we PARK it
// here — a persisted FIFO — and drain it one item at a time as each run finishes.
// Persisted (survives SW recycles) so a queued run isn't lost when Chrome recycles
// the worker mid-run.

const QUEUE_KEY = 'researchQueue';

// SINGLE-WRITER CHAIN (same race as research-store): enqueue/dequeue are
// get→(await)→set — two concurrent ops lose or resurrect items. Serialize all
// mutators; reads stay unsynchronized.
let queueChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = queueChain.then(fn, fn);
  queueChain = p.catch(() => {});
  return p;
}

export interface QueuedResearch {
  id: string;
  projectId: string;
  chatId?: string;
  topic: string;
  mode: 'quick' | 'deep';
  /** Source corpus for the parked run — 'academic' keeps /academic papers-only
   *  through the queue. Absent = 'auto'. */
  sourceMode?: 'auto' | 'academic';
  /** Topic already went through preview-time resolution — skip re-resolving. */
  preResolved?: boolean;
  queuedAt: number;
}

export async function getResearchQueue(): Promise<QueuedResearch[]> {
  try {
    const s = await chrome.storage.local.get([QUEUE_KEY]);
    return Array.isArray(s[QUEUE_KEY]) ? (s[QUEUE_KEY] as QueuedResearch[]) : [];
  } catch {
    return [];
  }
}

/** Append a run to the queue. Returns its 1-based position (queue length after push). */
export async function enqueueResearch(item: Omit<QueuedResearch, 'id' | 'queuedAt'>): Promise<number> {
  return serialized(async () => {
    const q = await getResearchQueue();
    const id = (crypto as any)?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    q.push({ ...item, id, queuedAt: Date.now() });
    await chrome.storage.local.set({ [QUEUE_KEY]: q });
    return q.length;
  });
}

/** Pop the oldest queued run (FIFO), or null if the queue is empty. */
export async function dequeueResearch(): Promise<QueuedResearch | null> {
  return serialized(async () => {
    const q = await getResearchQueue();
    const next = q.shift() ?? null;
    if (next) await chrome.storage.local.set({ [QUEUE_KEY]: q });
    return next;
  });
}

/** Remove a specific queued run by id (e.g. the user cancels it before it starts). */
export async function removeQueuedResearch(id: string): Promise<void> {
  return serialized(async () => {
    const q = await getResearchQueue();
    const next = q.filter(x => x.id !== id);
    if (next.length !== q.length) await chrome.storage.local.set({ [QUEUE_KEY]: next });
  });
}

export async function clearResearchQueue(): Promise<void> {
  return serialized(() => chrome.storage.local.set({ [QUEUE_KEY]: [] }));
}
