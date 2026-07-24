// ─────────────────────────────────────────────
// Reading the field log
// ─────────────────────────────────────────────
// The deep-research worker emits a flat stream of `[LABEL] message` lines. The
// field log used to show the last three of them raw — "[WEB] Reading 3/8:
// https://…" — which tells a watcher almost nothing about where the run is or
// how much is left.
//
// This folds that same stream into a structured snapshot: which of the four
// pipeline phases is active, how many sources have been captured versus failed,
// and the progress of the batch currently being read. It is PURE and derived
// entirely from the log lines, so the worker did not have to grow a second
// progress channel and nothing here can fall out of sync with what actually
// happened — the log is the single source of truth.

/** The four phases a run moves through, in order. */
export type ResearchPhase = 'planning' | 'gathering' | 'analyzing' | 'reviewing' | 'done' | 'error';

export const PHASE_ORDER: ResearchPhase[] = ['planning', 'gathering', 'analyzing', 'reviewing'];

export const PHASE_LABEL: Record<ResearchPhase, string> = {
  planning: 'Planning',
  gathering: 'Gathering sources',
  analyzing: 'Analyzing',
  reviewing: 'Reviewing',
  done: 'Done',
  error: 'Error',
};

/** Which phase each `[LABEL]` prefix belongs to. */
const LABEL_PHASE: Record<string, ResearchPhase> = {
  PLANNING: 'planning',
  WEB: 'gathering',
  ACADEMIC: 'gathering',
  NEWS: 'gathering',
  MCP: 'gathering',
  AGENTS: 'gathering',
  SYNTHESIZING: 'analyzing',
  REFS: 'analyzing',
  EVALUATING: 'reviewing',
  FAITHFULNESS: 'reviewing',
  FIGURES: 'reviewing',
  AUDIT: 'reviewing',
  DONE: 'done',
  ERROR: 'error',
  // INDEX and QUEUE are housekeeping, not a phase — they leave `phase` unchanged.
};

export interface ResearchActivity {
  /** The phase the run is currently in. */
  phase: ResearchPhase;
  /** Sources successfully captured so far. */
  captured: number;
  /** Sources that failed to capture. */
  failed: number;
  /** Progress of the read batch in flight, or null when nothing is reading. */
  reading: { done: number; total: number } | null;
  /** The most recent line, cleaned of its `[LABEL]` prefix for display. */
  latest: string;
  /** The label of the most recent line (WEB, ACADEMIC, …), for an icon. */
  latestLabel: string;
  /** True once a DONE or ERROR line has arrived. */
  finished: boolean;
}

const LINE = /^\s*\[([A-Z]+)\]\s*(.*)$/;
const READING = /\bReading\s+(\d+)\s*\/\s*(\d+)/;

/**
 * Fold the whole log into the current snapshot.
 *
 * `captured` / `failed` accumulate across every line; `phase`, `reading` and
 * `latest` reflect the most recent meaningful line. Reading the entire array
 * each call is deliberate and cheap — a run emits on the order of hundreds of
 * lines, and a fold that cannot disagree with itself is worth more than an
 * incremental counter that can.
 */
export function parseResearchActivity(log: string[]): ResearchActivity {
  let phase: ResearchPhase = 'planning';
  let captured = 0;
  let failed = 0;
  let reading: { done: number; total: number } | null = null;
  let latest = '';
  let latestLabel = '';
  let finished = false;

  for (const raw of log) {
    const m = LINE.exec(raw);
    if (!m) {
      // A line without a label is still the freshest human text.
      if (raw.trim()) latest = raw.trim();
      continue;
    }
    const label = m[1];
    const body = m[2].trim();

    // Capture tallies use the checkmarks the worker already prints.
    if (body.startsWith('✓')) captured++;
    else if (body.startsWith('✗')) failed++;

    // Batch progress: the newest "Reading i/N" wins; anything else on a
    // gathering line clears it, since the batch has moved on.
    const r = READING.exec(body);
    if (r) reading = { done: Number(r[1]), total: Number(r[2]) };
    else if (LABEL_PHASE[label] === 'gathering' && !body.startsWith('✓') && !body.startsWith('✗')) reading = null;

    const p = LABEL_PHASE[label];
    if (p) {
      phase = p;
      if (p === 'done' || p === 'error') finished = true;
    }
    // Once analysis starts, no gathering batch is in flight.
    if (p && p !== 'gathering') reading = null;

    if (body) { latest = body; latestLabel = label; }
  }

  return { phase, captured, failed, reading, latest, latestLabel, finished };
}

/** How far through the four-phase pipeline, as 0..1, for a progress bar. */
export function phaseProgress(phase: ResearchPhase): number {
  if (phase === 'done') return 1;
  const i = PHASE_ORDER.indexOf(phase);
  if (i < 0) return phase === 'error' ? 1 : 0;
  // Midpoint of the active phase: "in gathering" reads as further along than
  // "just entered gathering", without pretending to know sub-phase progress.
  return (i + 0.5) / PHASE_ORDER.length;
}
