# Implementation Plan: AI Research Assistant — Phase 3 (Retrieval Quality & Hardening)

## Overview

Phase 2 delivered streaming chat, PDF/YouTube capture fixes, library-first capture,
Obsidian frontmatter, slash commands, and multi-agent deep research. Phase 3 makes
retrieval actually semantic (embeddings + hybrid ranking), stops deep-research
side effects from polluting the session index, makes long research runs survivable
(persistent progress, streaming synthesis), and adds the missing engineering floor:
tests and a README.

## Architecture Decisions

- **Hybrid retrieval on Orama v3 (already installed, 3.1.18 supports `mode: 'hybrid'`
  and `vector` schema fields).** No new search dependency; BM25 stays as the
  always-available baseline.
- **Embeddings come from the user's existing OpenAI-compatible endpoint**
  (`/embeddings`; Ollama exposes it, e.g. `nomic-embed-text`). New optional
  "Embedding Model" setting. When unset → pure BM25, zero behavior change.
- **Embed at write time, persist vectors on chunk records in IndexedDB.**
  The MV3 worker dies after ~30 s idle; rehydration must NOT re-embed (cost,
  latency). Vectors are data, loaded with chunks.
- **Store `embeddingModel` name alongside vectors.** Model switch ⇒ dimensions
  change ⇒ stored vectors invalid. Mismatch detected at index build → those
  chunks fall back to BM25 until re-embedded (backfill task).
- **Ephemeral deep-research chunks stay BM25-only.** Research is bursty
  (dozens of pages); embedding them would slow runs and hammer local Ollama.
  Synthesis already filters by docId; keyword ranking is adequate there.
- **Coordination risk:** a second AI agent session has been editing this repo in
  parallel. Before each task: `git status`/re-read touched files. Prefer additive
  files over restructuring shared ones.

## Task List

### Phase A: Test Foundation (fail-fast floor)

#### Task 1: Vitest infrastructure + chunker tests
**Description:** Add `vitest` to `apps/extension`, `npm test` script, first test
file covering `lib/chunker.ts` (heading splits, anchor IDs, char offsets, empty
input, frontmatter handling).
**Acceptance criteria:**
- [ ] `npm test` runs green in `apps/extension`
- [ ] ≥6 chunker assertions incl. one regression case with YAML frontmatter
**Verification:** `npm test`; `npm run build` still clean.
**Dependencies:** None.
**Files:** `package.json`, `vitest.config.ts`, `src/lib/__tests__/chunker.test.ts`
**Scope:** S

#### Task 2: Frontmatter + citations tests
**Description:** Tests for `lib/frontmatter.ts` (escaping, tag normalization,
`hasFrontmatter`) and `lib/citations.ts` (anchor regex parse, context budget cap).
**Acceptance criteria:**
- [ ] Quotes/newlines in titles escape correctly; tags contain no illegal chars
- [ ] Citation parser resolves known anchors, ignores malformed ones
**Verification:** `npm test`
**Dependencies:** Task 1.
**Files:** `src/lib/__tests__/frontmatter.test.ts`, `src/lib/__tests__/citations.test.ts`
**Scope:** S

### Checkpoint A
- [ ] `npm test` + `npm run build` green. Commit.

### Phase B: Semantic Retrieval (vertical slice: setting → embed → store → search)

#### Task 3: Embedding settings + lib
**Description:** Add "Embedding Model" field to SettingsView (reuses model list
fetch). New `src/lib/embeddings.ts`: `embedTexts(texts: string[]): Promise<number[][]>`
batched POST to `{base}/embeddings`, 1 retry, returns `[]` when model unset.
**Acceptance criteria:**
- [ ] Setting persists in `chrome.storage.local` (`embedModel`)
- [ ] `embedTexts` unit-tested with mocked fetch (batching, unset → `[]`, error → throw)
**Verification:** `npm test`; manual: set `nomic-embed-text` with Ollama, no console errors.
**Dependencies:** Task 1.
**Files:** `src/lib/embeddings.ts`, `SettingsView.tsx`, `App.tsx`, test file
**Scope:** M

#### Task 4: Persist vectors on chunks at save time
**Description:** Extend `Chunk` with `embedding?: number[]` + `embeddingModel?: string`.
In `saveDocument` path (worker), embed chunk texts before persisting (skip silently
when no model configured). IndexedDB schema bump if store needs it.
**Acceptance criteria:**
- [ ] New captures store vectors when model set; store nothing when unset
- [ ] Existing docs load fine (field optional, no migration crash)
**Verification:** capture page → inspect chunk in IndexedDB (Studio/devtools) → vector present.
**Dependencies:** Task 3.
**Files:** `src/lib/db.ts`, `src/background/service-worker.ts`
**Scope:** M

#### Task 5: Hybrid search in vector-store
**Description:** `vector-store.ts`: create Orama schema with `embedding: vector[N]`
(N from first available vector; rebuild index if dimension differs). `searchSessionChunks`
embeds the query and uses `mode: 'hybrid'` when the session has vectors; falls back
to current BM25 otherwise. Mixed indexes (some chunks vectorless) must not crash.
**Acceptance criteria:**
- [ ] With embed model set: paraphrase queries retrieve relevant chunks that BM25 misses
  (manual A/B on one captured doc)
- [ ] With model unset or mismatched: behavior identical to today
**Verification:** `npm test` (index build unit test with fake vectors); manual A/B.
**Dependencies:** Task 4.
**Files:** `src/lib/vector-store.ts`, test file
**Scope:** M — highest-risk task in the plan; do first within Phase B if resequencing.

#### Task 6: Backfill re-embedding
**Description:** "Re-index embeddings" button in Settings → worker message iterates
all docs, embeds chunks lacking a vector for the current model, progress via
existing BroadcastChannel toast pattern.
**Acceptance criteria:**
- [ ] Old docs get vectors; re-run is a no-op; model switch re-embeds
**Verification:** manual: import doc → set model → backfill → hybrid retrieval hits it.
**Dependencies:** Tasks 4, 5.
**Files:** `service-worker.ts`, `SettingsView.tsx`, `App.tsx`
**Scope:** S

### Checkpoint B
- [ ] Retrieval A/B documented in PR/commit message (3 example queries, before/after)
- [ ] BM25-only path regression-free. Commit.

### Phase C: Deep Research Robustness

#### Task 7: Evict ephemeral chunks after research
**Description:** Repeated `/research` runs accumulate ephemeral chunks in the
session index until worker restart. Add `removeDocsFromVectorStore(sessionId, docIds)`
(Orama `remove` or index rebuild without those docIds) and call it in a `finally`
after synthesis.
**Acceptance criteria:**
- [ ] After research completes/fails, source chunks no longer surface in chat retrieval
- [ ] Saved synthesis report chunks remain searchable
**Verification:** unit test on eviction; manual: run research, then chat query for a
source-only phrase → not cited.
**Dependencies:** None (parallel to Phase B).
**Files:** `src/lib/vector-store.ts`, `src/background/deep-researcher.ts`
**Scope:** S

#### Task 8: Persist research progress; replay on reopen
**Description:** Worker keeps per-project log array in `chrome.storage.session`
(cleared on run start, appended per progress line). Sidepanel on mount reads it and
restores the "researching" banner if a run is active (worker sets `running` flag).
**Acceptance criteria:**
- [ ] Close panel mid-run → reopen → log restored, live updates continue
- [ ] Completed run: banner cleared, no stale flag after worker restart (flag carries timestamp; >30 min = stale)
**Verification:** manual mid-run close/reopen; unit test for stale-flag logic.
**Dependencies:** None.
**Files:** `service-worker.ts`, `App.tsx`
**Scope:** M

#### Task 9: Academic agent resilience
**Description:** S2 free pool 429s frequently (observed live). Add 2 retries with
2 s/8 s backoff, optional `s2ApiKey` setting sent as `x-api-key`, and per-sub-question
query variation (currently only topic is searched).
**Acceptance criteria:**
- [ ] 429 → retries → surfaces "rate-limited, continuing without S2" progress line, run completes
- [ ] Key setting honored when present
**Verification:** unit test with mocked 429 sequence.
**Dependencies:** None.
**Files:** `deep-researcher.ts`, `SettingsView.tsx`, `App.tsx`
**Scope:** S

### Checkpoint C
- [ ] Two consecutive `/deepresearch` runs: no cross-contamination, logs survive reopen. Commit.

### Phase D: Polish

#### Task 10: README
**Description:** Root README: what it is, features, install (load unpacked),
provider setup (Ollama/OpenRouter incl. embedding model), commands table,
architecture sketch (worker/offscreen/sidepanel/content), dev commands.
**Acceptance criteria:**
- [ ] Fresh user can install + configure from README alone
**Verification:** follow it top-to-bottom once.
**Dependencies:** All prior (documents final state).
**Files:** `README.md`
**Scope:** S

#### Task 11: Stream research synthesis into chat
**Description:** Deep research currently blocks until the full report returns. Route
the synthesis call through the existing SSE streaming path and forward deltas over
the research progress channel so the report renders live.
**Acceptance criteria:**
- [ ] Report tokens appear incrementally during `[SYNTHESIZING]`
- [ ] Persisted chat message identical to streamed content
**Verification:** manual run; cancel mid-synthesis keeps partial (matches chat behavior).
**Dependencies:** None technically; last because it touches the busiest shared file.
**Files:** `service-worker.ts`, `deep-researcher.ts`, `App.tsx`
**Scope:** M

### Checkpoint D — Complete
- [ ] All tests green, build clean, README accurate
- [ ] Manual smoke: capture (web/PDF/YT) → chat with citations → /deepresearch → export

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Parallel agent session clobbers edits | High | Re-read files before each edit; additive files preferred; small commits per task |
| Orama hybrid API differs from expectation | Med | Task 5 flagged highest-risk — spike it first inside Phase B; BM25 fallback always kept |
| Embedding dimension mismatch on model switch | Med | Store model name per vector; mismatch → BM25 fallback + backfill button |
| Ollama embedding latency on large captures | Med | Batch requests; embed failures never block save (vectorless chunk is valid) |
| S2 free tier effectively unusable at times | Low | Retries + optional key + HF papers already redundant |

## Open Questions

1. Default embedding model name to pre-fill (suggest `nomic-embed-text`) — or leave blank?
2. Should backfill auto-run on model change, or stay manual button only? (Plan assumes manual.)
3. Task 11 (streaming synthesis): worth it now, or defer to Phase 4? Cut line is after Task 10.
