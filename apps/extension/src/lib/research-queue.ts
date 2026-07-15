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

export interface QueuedResearch {
  id: string;
  projectId: string;
  chatId?: string;
  topic: string;
  mode: 'quick' | 'deep';
  /** Source corpus for the parked run — 'academic' keeps /academic papers-only
   *  through the queue. Absent = 'auto'. */
  sourceMode?: 'auto' | 'academic';
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
  const q = await getResearchQueue();
  const id = (crypto as any)?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  q.push({ ...item, id, queuedAt: Date.now() });
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
  return q.length;
}

/** Pop the oldest queued run (FIFO), or null if the queue is empty. */
export async function dequeueResearch(): Promise<QueuedResearch | null> {
  const q = await getResearchQueue();
  const next = q.shift() ?? null;
  if (next) await chrome.storage.local.set({ [QUEUE_KEY]: q });
  return next;
}

/** Remove a specific queued run by id (e.g. the user cancels it before it starts). */
export async function removeQueuedResearch(id: string): Promise<void> {
  const q = await getResearchQueue();
  const next = q.filter(x => x.id !== id);
  if (next.length !== q.length) await chrome.storage.local.set({ [QUEUE_KEY]: next });
}

export async function clearResearchQueue(): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: [] });
}
