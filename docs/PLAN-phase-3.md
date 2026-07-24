# Implementation Plan: AI Research Assistant — Phase 3 (Retrieval Quality & Hardening)

**Status: 9 of 11 tasks done** (Tasks 1, 2, 4-10; verified against current code plus
a green `npm test` — 52 files/535 tests — and `npm run build`), several exceeding
their original acceptance criteria (see per-task checkboxes below). Two exceptions,
both left unchecked below: **Task 3** was superseded by a bundled local ONNX
embedder in the offscreen doc (no user-facing "Embedding Model" setting or
`/embeddings` endpoint call — see note under Task 3), and **Task 11**'s backend
streaming shipped but the sidepanel intentionally drops the deltas (perf regression
— see note under Task 11).

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
- [x] `npm test` runs green in `apps/extension` — `vitest.config.ts` + `"test": "vitest run"` exist; currently 52 files / 535 tests pass
- [x] ≥6 chunker assertions incl. one regression case with YAML frontmatter — `src/lib/__tests__/chunker.test.ts` has 15 assertions incl. the frontmatter regression case
**Verification:** `npm test`; `npm run build` still clean.
**Dependencies:** None.
**Files:** `package.json`, `vitest.config.ts`, `src/lib/__tests__/chunker.test.ts`
**Scope:** S

#### Task 2: Frontmatter + citations tests
**Description:** Tests for `lib/frontmatter.ts` (escaping, tag normalization,
`hasFrontmatter`) and `lib/citations.ts` (anchor regex parse, context budget cap).
**Acceptance criteria:**
- [x] Quotes/newlines in titles escape correctly; tags contain no illegal chars — `src/lib/__tests__/frontmatter.test.ts`
- [x] Citation parser resolves known anchors, ignores malformed ones — `src/lib/__tests__/citations.test.ts` (`stripCitations`, `buildCitationContext`)
**Verification:** `npm test`
**Dependencies:** Task 1.
**Files:** `src/lib/__tests__/frontmatter.test.ts`, `src/lib/__tests__/citations.test.ts`
**Scope:** S

### Checkpoint A
- [x] `npm test` + `npm run build` green. Commit. — re-verified: 52 files/535 tests pass, `tsc && vite build` clean.

### Phase B: Semantic Retrieval (vertical slice: setting → embed → store → search)

#### Task 3: Embedding settings + lib
**Description:** Add "Embedding Model" field to SettingsView (reuses model list
fetch). New `src/lib/embeddings.ts`: `embedTexts(texts: string[]): Promise<number[][]>`
batched POST to `{base}/embeddings`, 1 retry, returns `[]` when model unset.

**Superseded — not implemented as described.** No `src/lib/embeddings.ts`, no
`embedModel` storage key, no "Embedding Model" SettingsView field exist (verified
via repo-wide grep). Instead the project shipped a bundled local ONNX embedder
(`multilingual-e5-small`, 384-dim) that runs in the offscreen document's inference
worker (`src/offscreen/offscreen.ts:201` `generateEmbeddings`, invoked via the
`OFFSCREEN_GET_EMBEDDINGS` action) — always on, no user setting or external
`/embeddings` endpoint needed. Tasks 4-6's underlying goals (vectors persisted at
write time, hybrid search, backfill on model change) were still achieved through
this path — see those tasks below.
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
- [x] New captures store vectors when model set; store nothing when unset — `src/lib/db.ts:19-33` (`embedTextsBatched`) called before every IDB write (`db.ts:576-577`, `768-775`); failed batches store `null`/vectorless, never block save
- [x] Existing docs load fine (field optional, no migration crash) — `Chunk.embedding?: number[]` is optional (`db.ts:87`); `vector-store.ts:82` falls back to a zero-vector for chunks without one
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
- [x] With embed model set: paraphrase queries retrieve relevant chunks that BM25 misses
  (manual A/B on one captured doc) — implemented as Reciprocal Rank Fusion of a
  separate lexical (BM25) run and a `mode: 'vector'` run (`vector-store.ts:458-501`
  `runSearch`), not Orama's built-in `mode: 'hybrid'`, but achieves the same outcome
- [x] With model unset or mismatched: behavior identical to today — `runSearch` skips
  the vector branch entirely when `queryVector` is `null` (embed call failed/timed
  out), falling back to pure lexical search (`vector-store.ts:486-497`)
**Verification:** `npm test` (index build unit test with fake vectors); manual A/B. — `src/lib/__tests__/rrf.test.ts` covers the fusion logic with fake 384-dim vectors
**Dependencies:** Task 4.
**Files:** `src/lib/vector-store.ts`, test file
**Scope:** M — highest-risk task in the plan; do first within Phase B if resequencing.

#### Task 6: Backfill re-embedding
**Description:** "Re-index embeddings" button in Settings → worker message iterates
all docs, embeds chunks lacking a vector for the current model, progress via
existing BroadcastChannel toast pattern.
**Acceptance criteria:**
- [x] Old docs get vectors; re-run is a no-op; model switch re-embeds — "Re-index
  library" button in Settings (`SettingsView.tsx:1238-1253`) → `handleReindexLibrary`
  (`service-worker.ts:1279-1323`) re-chunks + re-embeds every doc with progress over
  the `ai_research_assistant_import` BroadcastChannel, guarded against concurrent
  runs; a separate startup check (`service-worker.ts:3663-3685`) diffs a stored
  `CURRENT_EMBED_MODEL` constant against `chrome.storage.local` and auto-triggers
  the same reindex exactly once when the bundled model changes (no-op otherwise)
**Verification:** manual: import doc → set model → backfill → hybrid retrieval hits it.
**Dependencies:** Tasks 4, 5.
**Files:** `service-worker.ts`, `SettingsView.tsx`, `App.tsx`
**Scope:** S

### Checkpoint B
- [ ] Retrieval A/B documented in PR/commit message (3 example queries, before/after) — no such commit/PR note found in `git log`
- [ ] BM25-only path regression-free. Commit.

### Phase C: Deep Research Robustness

#### Task 7: Evict ephemeral chunks after research
**Description:** Repeated `/research` runs accumulate ephemeral chunks in the
session index until worker restart. Add `removeDocsFromVectorStore(sessionId, docIds)`
(Orama `remove` or index rebuild without those docIds) and call it in a `finally`
after synthesis.
**Acceptance criteria:**
- [x] After research completes/fails, source chunks no longer surface in chat retrieval —
  implemented via `resetSessionIndex(projectId)` (not a new `removeDocsFromVectorStore`)
  called in `executeResearch`'s `finally` block (`service-worker.ts:3559-3565`); ephemeral
  research-source chunks only ever lived in the in-memory index, so dropping it evicts them
- [x] Saved synthesis report chunks remain searchable — persisted docs (source pages +
  synthesis report) transparently rehydrate from IndexedDB on the next search (same comment,
  `service-worker.ts:3563-3564`)
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
- [x] Close panel mid-run → reopen → log restored, live updates continue — exceeded: a
  full crash-safe job store (`src/lib/research-store.ts`) persists topic, phase, stage
  briefs, outline, section drafts, and a bounded `logs[]` (300 lines) to
  `chrome.storage.local`; `App.tsx`'s `visibilitychange` handler calls `GET_RESEARCH_STATUS`
  and restores both `researchLogs` and the `researching` banner (`App.tsx:310-336`)
- [x] Completed run: banner cleared, no stale flag after worker restart (flag carries
  timestamp; >30 min = stale) — implemented as a 3-min heartbeat (`HEARTBEAT_STALE_MS`,
  `research-store.ts:12`) + 12h hard age ceiling (`isJobStale`, `research-store.ts:162-172`),
  stricter than the plan's 30-min window; a full resume-on-startup path also exists
  (`service-worker.ts` `resumePendingResearch`)
**Verification:** manual mid-run close/reopen; unit test for stale-flag logic. — `src/lib/__tests__/research-store.test.ts`
**Dependencies:** None.
**Files:** `service-worker.ts`, `App.tsx`
**Scope:** M

#### Task 9: Academic agent resilience
**Description:** S2 free pool 429s frequently (observed live). Add 2 retries with
2 s/8 s backoff, optional `s2ApiKey` setting sent as `x-api-key`, and per-sub-question
query variation (currently only topic is searched).
**Acceptance criteria:**
- [x] 429 → retries → surfaces "rate-limited, continuing without S2" progress line, run
  completes — `s2Fetch` retries with `[0, 2000, 8000]` ms backoff on 429
  (`deep-researcher.ts:1193-1210`); on exhaustion `runAcademicAgent` catches and emits
  `[ACADEMIC] Semantic Scholar unavailable (...) — continuing` (`deep-researcher.ts:1506-1510`)
  and the run proceeds. Wording differs from the plan's exact quoted string; no dedicated
  unit test mocks a 429 sequence for `s2Fetch` specifically (gap vs. the stated Verification)
- [x] Key setting honored when present — `s2ApiKey` read from `chrome.storage.local` and sent
  as `x-api-key` (`deep-researcher.ts:1193-1198`); Settings field exists (`SettingsView.tsx:1023-1029`).
  Per-sub-question query variation also landed (`opts.queries` in `runAcademicAgent`, wired from
  stage queries at the `/academic` call site, `deep-researcher.ts:3218-3229`) — the plan's "currently
  only topic is searched" gap is closed for academic-mode runs
**Verification:** unit test with mocked 429 sequence. — not found; retry/backoff logic is unverified by an automated test
**Dependencies:** None.
**Files:** `deep-researcher.ts`, `SettingsView.tsx`, `App.tsx`
**Scope:** S

### Checkpoint C
- [ ] Two consecutive `/deepresearch` runs: no cross-contamination, logs survive reopen. Commit. — no direct evidence found (manual QA artifact); Tasks 7 + 8 above give strong code-level support

### Phase D: Polish

#### Task 10: README
**Description:** Root README: what it is, features, install (load unpacked),
provider setup (Ollama/OpenRouter incl. embedding model), commands table,
architecture sketch (worker/offscreen/sidepanel/content), dev commands.
**Acceptance criteria:**
- [x] Fresh user can install + configure from README alone — root `README.md` (136 lines)
  covers what it is, features, install (clone/npm install/build/load-unpacked), a
  commands table, and an architecture sketch. It does not document manual Ollama/OpenRouter
  provider setup or an "embedding model" (moot — Task 3 was superseded, no such setting
  exists), which is consistent with provider auto-detection landing separately
**Verification:** follow it top-to-bottom once.
**Dependencies:** All prior (documents final state).
**Files:** `README.md`
**Scope:** S

#### Task 11: Stream research synthesis into chat
**Description:** Deep research currently blocks until the full report returns. Route
the synthesis call through the existing SSE streaming path and forward deltas over
the research progress channel so the report renders live.

**Backend done, frontend intentionally reverted — acceptance criteria NOT met.**
`service-worker.ts`'s `synthesisFn` (~line 3425) streams via `chatWithCustomStream`
and broadcasts each delta as `DEEP_RESEARCH_DELTA`. But `App.tsx`'s handler for that
action is a no-op by design: "Report tokens are intentionally NOT rendered live.
Re-parsing the whole growing markdown report every flush saturated the main thread
(frozen caret / unresponsive panel...). Deltas are dropped here." (`App.tsx:621-627`).
The report still renders as one block on `DEEP_RESEARCH_DONE` via `loadChatHistory`.
**Acceptance criteria:**
- [ ] Report tokens appear incrementally during `[SYNTHESIZING]` — NOT met; deltas are received but discarded (`App.tsx:621-627`)
- [ ] Persisted chat message identical to streamed content — moot, since nothing streams to the UI
**Verification:** manual run; cancel mid-synthesis keeps partial (matches chat behavior).
**Dependencies:** None technically; last because it touches the busiest shared file.
**Files:** `service-worker.ts`, `deep-researcher.ts`, `App.tsx`
**Scope:** M

### Checkpoint D — Complete
- [x] All tests green, build clean, README accurate — re-verified directly: `npm test` → 52 files/535 tests pass; `npm run build` (`tsc && vite build` ×3 entries) completes clean
- [ ] Manual smoke: capture (web/PDF/YT) → chat with citations → /deepresearch → export — no evidence found (manual QA artifact)

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
