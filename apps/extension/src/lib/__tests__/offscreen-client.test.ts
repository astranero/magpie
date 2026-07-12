import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendToOffscreen, setEnsureOffscreen } from '../offscreen-client';

/**
 * The offscreen doc runs ONE ONNX/WASM context. Two embedding batches in flight
 * at once (deep research + a chat query typed mid-run) OOM the WASM heap and
 * crash the renderer. sendToOffscreen must therefore serialize every call.
 */
describe('sendToOffscreen serialization mutex', () => {
  beforeEach(() => {
    setEnsureOffscreen(async () => {});
  });

  it('never runs two offscreen calls concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    // Stub chrome.runtime.sendMessage: each call is "in flight" for a tick.
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise(r => setTimeout(r, 5));
          active--;
          return { ok: true };
        })
      }
    };

    // Fire a burst concurrently — simulating research + chat hitting the embedder.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => sendToOffscreen({ action: 'OFFSCREEN_GET_EMBEDDINGS', i }))
    );

    expect(maxActive).toBe(1);
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledTimes(8);
  });

  it('a failing call still releases the queue for the next one', async () => {
    const order: string[] = [];
    let n = 0;
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn(async () => {
          const id = n++;
          order.push(`start${id}`);
          await new Promise(r => setTimeout(r, 3));
          if (id === 0) throw new Error('boom'); // first call fails
          order.push(`ok${id}`);
          return { ok: true };
        })
      }
    };

    const first = sendToOffscreen({ action: 'A' }).catch(() => 'caught');
    const second = sendToOffscreen({ action: 'B' });
    await expect(first).resolves.toBe('caught');
    await expect(second).resolves.toEqual({ ok: true });
    // The second call ran AFTER the first finished (serialized), not interleaved.
    expect(order).toEqual(['start0', 'start1', 'ok1']);
  });

  it('a priority call jumps ahead of already-queued normal calls', async () => {
    const order: number[] = [];
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn(async (m: any) => {
          order.push(m.i);
          await new Promise(r => setTimeout(r, 3));
          return { ok: true };
        })
      }
    };

    // First call holds the lock. While it runs, enqueue two normals then a
    // priority one. The priority call must run BEFORE the earlier-queued
    // normals — this is what keeps a chat query from freezing behind a whole
    // research run's worth of queued embedding batches.
    const running = sendToOffscreen({ action: 'X', i: 0 });
    await Promise.resolve(); // let the first call acquire the lock
    const n1 = sendToOffscreen({ action: 'X', i: 1 });
    const n2 = sendToOffscreen({ action: 'X', i: 2 });
    const hi = sendToOffscreen({ action: 'X', i: 9 }, undefined, { priority: true });
    await Promise.all([running, n1, n2, hi]);

    expect(order[0]).toBe(0);   // the in-flight call finishes first
    expect(order[1]).toBe(9);   // priority jumps the two waiting normals
    expect(order.slice(2)).toEqual([1, 2]); // normals keep FIFO among themselves
  });

  it('priority calls preserve FIFO among themselves', async () => {
    const order: number[] = [];
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn(async (m: any) => {
          order.push(m.i);
          await new Promise(r => setTimeout(r, 3));
          return { ok: true };
        })
      }
    };
    const running = sendToOffscreen({ action: 'X', i: 0 });
    await Promise.resolve();
    const a = sendToOffscreen({ action: 'X', i: 1 }, undefined, { priority: true });
    const b = sendToOffscreen({ action: 'X', i: 2 }, undefined, { priority: true });
    await Promise.all([running, a, b]);
    expect(order).toEqual([0, 1, 2]);
  });
});
