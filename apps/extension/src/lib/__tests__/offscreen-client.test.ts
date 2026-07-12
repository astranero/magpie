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
});
