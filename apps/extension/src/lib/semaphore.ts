// ─────────────────────────────────────────────
// Semaphore — bounded async concurrency
// ─────────────────────────────────────────────
// Wrap a critical section so at most `n` invocations run concurrently.
// Used to cap contention on the single offscreen document during deep
// research: scraping stays parallel (I/O bound), embedding indexing gets
// serialized (WebGPU bound) to prevent starving sidepanel search queries.

export interface Semaphore {
  <T>(fn: () => Promise<T>): Promise<T>;
}

export function semaphore(n: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async () => {
    if (active < n) { active++; return; }
    await new Promise<void>(resolve => waiters.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try { return await fn(); }
    finally { release(); }
  };
}
