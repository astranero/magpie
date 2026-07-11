// ─────────────────────────────────────────────
// Research Job Store — Magpie
// ─────────────────────────────────────────────
// Crash-safe research job state:
//   - job state (topic, plan, phase, logs)  → chrome.storage.local (small)
//   - scraped page cache                    → IndexedDB (large)
//
// The service worker can die at any time. Every mutation is written to
// persistent storage so `resumePendingResearch` can pick up where we left off.

export const JOB_KEY = 'magpie-research-job';
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;      // 3 min — stale heartbeat → resumable
export const JOB_MAX_AGE_MS = 12 * 60 * 60 * 1000;    // 12 h — hard age ceiling

const MAX_LOGS = 300;

export interface ResearchJob {
  projectId: string;
  chatId?: string;
  topic: string;
  effectiveTopic: string;
  mode: 'quick' | 'deep';
  startedAt: string;
  phase: 'planning' | 'gathering' | 'synthesizing';
  subQuestions?: string[];
  webQueries?: string[];
  processedQueries?: string[];  // track which queries have been processed for deduplication
  /** Per-stage markdown briefs — each entry is the full brief for that stage (0-indexed). */
  stageBriefs?: string[];
  /** Index (1-based) of the last fully completed stage. 0 = none done yet. */
  currentStage?: number;
  logs: string[];
  resumeAttempts?: number;
  active?: boolean;
  lastHeartbeatAt?: number;
}

export interface CachedPage {
  url: string;
  title: string;
  markdown: string;
  label: string; // WEB | ACADEMIC | NEWS
}

// ── Job state (chrome.storage.local) ──

export async function getJob(): Promise<ResearchJob | null> {
  const s = await chrome.storage.local.get([JOB_KEY]);
  return (s[JOB_KEY] as ResearchJob) ?? null;
}

/** Start (or replace) the current research job. */
export async function startJob(seed: Omit<ResearchJob, 'startedAt' | 'phase' | 'logs'>): Promise<void> {
  const full: ResearchJob = {
    ...seed,
    startedAt: new Date().toISOString(),
    phase: 'planning',
    logs: [],
    resumeAttempts: 0,
    active: false
  };
  await chrome.storage.local.set({ [JOB_KEY]: full });
}

/** Merge-patch the current job. No-op if there is no job. */
export async function updateJob(patch: Partial<ResearchJob>): Promise<void> {
  const job = await getJob();
  if (!job) return;
  await chrome.storage.local.set({ [JOB_KEY]: { ...job, ...patch } });
}

/** Append a log line (bounded to MAX_LOGS most-recent entries). */
export async function appendJobLog(line: string): Promise<void> {
  const job = await getJob();
  if (!job) return;
  const logs = [...(job.logs ?? []), line].slice(-MAX_LOGS);
  await chrome.storage.local.set({ [JOB_KEY]: { ...job, logs } });
}

/** Clear the current job entirely. */
export async function clearJob(): Promise<void> {
  await chrome.storage.local.remove(JOB_KEY);
}

/** Mark the job as actively running and refresh heartbeat. */
export async function markJobActive(): Promise<void> {
  const job = await getJob();
  if (!job) return;
  await chrome.storage.local.set({ [JOB_KEY]: { ...job, active: true, lastHeartbeatAt: Date.now() } });
}

/** Explicit finished marker — clearJob races can otherwise resurrect a done job. */
export async function markJobFinished(): Promise<void> {
  const job = await getJob();
  if (!job) return;
  await chrome.storage.local.set({ [JOB_KEY]: { ...job, active: false } });
}

/** Refresh heartbeat timestamp. Called periodically during execution. */
export async function updateHeartbeat(): Promise<void> {
  const job = await getJob();
  if (!job) return;
  await chrome.storage.local.set({ [JOB_KEY]: { ...job, lastHeartbeatAt: Date.now(), active: true } });
}

/** Increment resume attempt counter; returns the new count. */
export async function incrementResumeAttempts(): Promise<number> {
  const job = await getJob();
  if (!job) return 0;
  const newCount = (job.resumeAttempts ?? 0) + 1;
  await chrome.storage.local.set({ [JOB_KEY]: { ...job, resumeAttempts: newCount } });
  return newCount;
}

/** True when a running job's heartbeat has gone stale (worker died mid-run). */
export async function isJobStale(): Promise<boolean> {
  const job = await getJob();
  if (!job || !job.lastHeartbeatAt) return true;
  const now = Date.now();
  const started = Date.parse(job.startedAt);
  if (isNaN(started) || started + JOB_MAX_AGE_MS < now) return true;
  if (!job.active) return false;
  const elapsed = now - job.lastHeartbeatAt;
  return elapsed > HEARTBEAT_STALE_MS;
}

// ── Scraped page cache (own IndexedDB — independent of the main app DB) ──

const DB_NAME = 'MagpieResearchCacheDB';
const STORE = 'pages';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'url' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function savePage(page: CachedPage): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(page);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPage(url: string): Promise<CachedPage | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => resolve((req.result as CachedPage) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function listPages(): Promise<CachedPage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as CachedPage[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function clearPages(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
