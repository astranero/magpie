// ─────────────────────────────────────────────
// What the model sees of a long conversation
// ─────────────────────────────────────────────
// History was a hard `slice(-16)`: at turn 17, turn 1 vanished with no
// indication. Ask "what did we decide about the pricing?" thirty turns later and
// the model has never heard of it, while confidently answering anyway.
//
// The obvious fix — summarise everything — is worse than it looks. Appending a
// summary each turn grows context without limit. Capping it and re-summarising
// bounds the size but is lossy AND drifting: every re-summarisation compounds
// the last one's errors, and specifics (numbers, names, what was decided) are
// the first thing smoothed away. It also costs an LLM call per compaction.
//
// So: keep the recent window verbatim, RECALL the older exchanges that the
// current question actually touches, and carry a mechanically-built ledger of
// what has been discussed. All three are hard-capped, so the prompt has a fixed
// ceiling however long the conversation runs — and none of them costs a call.
//
// Scoring is LEXICAL, not embedded, deliberately. Embedding history would add an
// offscreen ONNX round-trip to every turn: straight onto time-to-first-token,
// and onto the heap with three documented OOM classes. Overlap on meaningful
// tokens is pure string work and runs in microseconds.

import { meaningfulTokens } from './unicode-text';

export interface Turn { role: string; content: string }

/** Verbatim tail. Eight messages is roughly four exchanges of immediate context. */
export const RECENT_MESSAGES = 8;
/** Older exchanges recalled by relevance. Three keeps the prompt bounded. */
export const MAX_RECALLED = 3;
/** An exchange must share this fraction of the query's tokens to be recalled. */
export const RELEVANCE_FLOOR = 0.34;
/** Ceiling on everything this module contributes. */
export const HISTORY_CHAR_BUDGET = 12_000;
/** Ceiling on the topic ledger alone. */
export const LEDGER_CHAR_BUDGET = 400;

export interface SelectedHistory {
  /** Messages to send, chronological, with elision markers where turns were cut. */
  turns: Turn[];
  /** One line naming earlier topics, or '' when there is nothing older. */
  ledger: string;
  /** How many messages were left out. */
  elided: number;
  /** How many older exchanges were recalled by relevance. */
  recalled: number;
}

/** A user message with the assistant reply that followed it. */
interface Exchange { start: number; end: number; question: string; text: string }

/**
 * Group messages into exchanges. An assistant turn is NEVER recalled without the
 * question it answers — an answer alone reads as the model asserting something
 * unprompted, and the model cannot tell what it was responding to.
 */
function toExchanges(turns: Turn[]): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'user') continue;
    let end = i;
    while (end + 1 < turns.length && turns[end + 1].role !== 'user') end++;
    out.push({
      start: i,
      end,
      question: turns[i].content,
      text: turns.slice(i, end + 1).map(t => t.content).join(' '),
    });
  }
  return out;
}

/**
 * Fraction of the query's meaningful tokens that also appear in the exchange.
 * Asymmetric on purpose: a long exchange should not be penalised for containing
 * more than the question asked about.
 */
export function overlapScore(query: string, text: string): number {
  const q = new Set(meaningfulTokens(query));
  if (q.size === 0) return 0;
  const t = new Set(meaningfulTokens(text));
  let hit = 0;
  for (const tok of q) if (t.has(tok)) hit++;
  return hit / q.size;
}

/**
 * A one-line record of what has been discussed, built from the user's own
 * earlier questions — no LLM call, no summarisation, nothing to drift. It gives
 * continuity ("we talked about X") while recall supplies the specifics.
 */
export function buildLedger(olderQuestions: string[], budget = LEDGER_CHAR_BUDGET): string {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const q of olderQuestions) {
    const one = q.replace(/\s+/g, ' ').trim();
    if (!one) continue;
    // Slash commands are instructions, not topics.
    if (one.startsWith('/')) continue;
    const short = one.length > 60 ? one.slice(0, 57).trimEnd() + '…' : one;
    const key = short.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(short);
  }
  if (items.length === 0) return '';
  const out: string[] = [];
  let used = 0;
  // Newest first: recent topics are likelier to matter than the oldest.
  for (const item of items.reverse()) {
    if (used + item.length + 3 > budget) break;
    out.push(item);
    used += item.length + 3;
  }
  return out.length ? `Earlier in this conversation the user asked about: ${out.join(' · ')}` : '';
}

/**
 * Choose what the model sees.
 *
 * Behaviour is IDENTICAL to the old `slice(-RECENT_MESSAGES)` whenever nothing
 * older clears the relevance floor, so short conversations are unaffected and
 * only a question that reaches back changes anything.
 *
 * Pass the RESOLVED query (after follow-up rewriting) — "what about the second
 * one?" shares no tokens with anything, while its resolved form does.
 */
export function selectHistory(all: Turn[], query: string, opts: {
  recent?: number; maxRecalled?: number; budget?: number;
} = {}): SelectedHistory {
  const recentN = opts.recent ?? RECENT_MESSAGES;
  const maxRecalled = opts.maxRecalled ?? MAX_RECALLED;
  const budget = opts.budget ?? HISTORY_CHAR_BUDGET;

  if (all.length <= recentN) {
    return { turns: all, ledger: '', elided: 0, recalled: 0 };
  }

  const cut = all.length - recentN;
  const older = all.slice(0, cut);
  const recent = all.slice(cut);

  const candidates = toExchanges(older)
    .map(e => ({ e, score: overlapScore(query, e.text) }))
    .filter(x => x.score >= RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRecalled)
    .sort((a, b) => a.e.start - b.e.start);   // back into chronological order

  // Budget: recent turns are never sacrificed for a recalled one.
  let used = recent.reduce((n, t) => n + t.content.length, 0);
  const kept: Exchange[] = [];
  for (const { e } of candidates) {
    if (used + e.text.length > budget) continue;
    used += e.text.length;
    kept.push(e);
  }

  const turns: Turn[] = [];
  let cursor = 0;
  let elided = 0;
  for (const e of kept) {
    if (e.start > cursor) elided += e.start - cursor;
    // The model must know the transcript is not contiguous, or it reads a
    // recalled exchange as the immediately preceding turn.
    if (e.start > cursor) turns.push({ role: 'system', content: '[… earlier turns omitted …]' });
    for (let i = e.start; i <= e.end; i++) turns.push(all[i]);
    cursor = e.end + 1;
  }
  if (cut > cursor) {
    elided += cut - cursor;
    // Marker ONLY when something was spliced in, i.e. when the transcript we
    // send is genuinely non-contiguous. With nothing recalled the output is the
    // plain recent window — byte-identical to the tail-slice this replaces,
    // which is the property that makes it safe to ship — and the ledger already
    // tells the model the conversation started earlier.
    if (kept.length) turns.push({ role: 'system', content: '[… earlier turns omitted …]' });
  }
  turns.push(...recent);

  const ledger = buildLedger(older.filter(t => t.role === 'user').map(t => t.content));
  return { turns, ledger, elided, recalled: kept.length };
}
