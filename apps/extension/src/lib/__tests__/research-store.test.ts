import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as researchStore from '../research-store';
import type { ResearchJob } from '../research-store';

let mockStorage: Map<string, any>;
let setMock: ReturnType<typeof vi.fn<any[], any>>;

function makeJob(over: Partial<ResearchJob> = {}): ResearchJob {
  return {
    projectId: 'test',
    topic: 'topic',
    effectiveTopic: 'topic',
    mode: 'quick',
    startedAt: new Date().toISOString(),
    phase: 'planning',
    logs: [],
    ...over,
  };
}

beforeEach(() => {
  mockStorage = new Map<string, any>();
  setMock = vi.fn<any[], any>(async (items: Record<string, any>) => {
    Object.entries(items).forEach(([key, value]) => {
      mockStorage.set(key, value);
    });
    return items;
  });

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: (keys: string[]) => {
          const result: Record<string, any> = {};
          const list = Array.isArray(keys) ? keys : [keys as unknown as string];
          list.forEach(key => {
            if (mockStorage.has(key)) result[key] = mockStorage.get(key);
          });
          return Promise.resolve(result);
        },
        set: setMock,
        remove: (key: string) => {
          mockStorage.delete(key);
          return Promise.resolve();
        },
      },
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).chrome = undefined;
});

describe('research-store heartbeat & resume gate', () => {
  it('updateHeartbeat writes lastHeartbeatAt', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    mockStorage.set(researchStore.JOB_KEY, makeJob({ active: true, lastHeartbeatAt: 0 }));

    await researchStore.updateHeartbeat();

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      [researchStore.JOB_KEY]: expect.objectContaining({ lastHeartbeatAt: now, active: true }),
    }));
  });

  it('markJobFinished sets active false', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    mockStorage.set(researchStore.JOB_KEY, makeJob({ active: true }));

    await researchStore.markJobFinished();

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      [researchStore.JOB_KEY]: expect.objectContaining({ active: false }),
    }));
  });

  it('isJobStale returns true for old heartbeat', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    mockStorage.set(researchStore.JOB_KEY, makeJob({
      lastHeartbeatAt: now - researchStore.HEARTBEAT_STALE_MS - 1,
      active: true,
      startedAt: new Date(now - 1000 * 60 * 61).toISOString(),
    }));
    const stale = await researchStore.isJobStale();
    expect(stale).toBe(true);
  });

  it('isJobStale returns false for fresh heartbeat', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    mockStorage.set(researchStore.JOB_KEY, makeJob({
      lastHeartbeatAt: now - researchStore.HEARTBEAT_STALE_MS + 1000,
      active: true,
      startedAt: new Date(now - 1000 * 60 * 30).toISOString(),
    }));
    const stale = await researchStore.isJobStale();
    expect(stale).toBe(false);
  });

  it('isJobStale false if active false even when heartbeat old', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    mockStorage.set(researchStore.JOB_KEY, makeJob({
      lastHeartbeatAt: now - researchStore.HEARTBEAT_STALE_MS - 1000,
      active: false,
      startedAt: new Date(now - 1000 * 60 * 61).toISOString(),
    }));
    const stale = await researchStore.isJobStale();
    expect(stale).toBe(false);
  });

  it('Job older than 12h is considered stale', async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    mockStorage.set(researchStore.JOB_KEY, makeJob({
      lastHeartbeatAt: now,
      startedAt: '2020-01-01T00:00:00Z',
      active: true,
    }));
    const stale = await researchStore.isJobStale();
    expect(stale).toBe(true);
  });

  it('incrementResumeAttempts increments and returns new count', async () => {
    mockStorage.set(researchStore.JOB_KEY, makeJob({ resumeAttempts: 1, active: true }));
    const count = await researchStore.incrementResumeAttempts();
    expect(count).toBe(2);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it('incrementResumeAttempts returns 0 if no job', async () => {
    const count = await researchStore.incrementResumeAttempts();
    expect(count).toBe(0);
  });
});
