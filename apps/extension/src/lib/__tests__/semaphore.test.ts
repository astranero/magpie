import { describe, it, expect } from 'vitest';
import { semaphore } from '../semaphore';

describe('semaphore', () => {
  it('allows up to n concurrent tasks', async () => {
    const sem = semaphore(2);
    let peak = 0;
    let active = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    };
    await Promise.all([sem(task), sem(task), sem(task), sem(task), sem(task)]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('runs all queued tasks in order of submission', async () => {
    const sem = semaphore(1);
    const order: number[] = [];
    const mk = (i: number) => async () => { order.push(i); };
    await Promise.all([sem(mk(1)), sem(mk(2)), sem(mk(3))]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('returns the value produced by the wrapped fn', async () => {
    const sem = semaphore(2);
    const result = await sem(async () => 42);
    expect(result).toBe(42);
  });

  it('releases the slot even if the wrapped fn throws', async () => {
    const sem = semaphore(1);
    await expect(sem(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Second call would hang if release didn't happen.
    const ok = await sem(async () => 'ok');
    expect(ok).toBe('ok');
  });
});
