# Implementation Plan: Phase 4 — Test Floor, Retrieval Completeness, Research UX

## Status of previous plans

**PLAN-page-context.md — DONE** (moved to `archive/completed-plans/`). All 4 tasks shipped (worker `getPageContext` +
5-min cache, chat-request injection block, both chat paths wired, 📄 toggle chip +
`/page` command). Remaining checkpoint item is the manual matrix
(article / YouTube / PDF × toggle on/off) — user acceptance, not code.

**PLAN-phase-3.md — 8 of 11 done:**

| Task | Status |
|---|---|
| T1 vitest + chunker tests | ✅ done (Phase 4 Task 1) — `vitest.config.ts` + `"test": "vitest run"` script exist; `npm test` runs 52 files / 535 tests green, incl. `src/lib/__tests__/chunker.test.ts` (headings, anchors, frontmatter regression, empty input) |
| T2 frontmatter/citations tests | ✅ done (Phase 4 Task 2) — `src/lib/__tests__/{frontmatter,citations,research-store}.test.ts` all pass (`normalizeCitations` comma-splitter was not extracted/tested — see Task 2 below) |
| T3 embedding settings + lib | ✅ superseded — local transformers.js model in offscreen (384-dim), no endpoint setting needed |
| T4 vectors persisted at save | ✅ `db.ts` embeds before IDB tx, optional field |
| T5 hybrid search | ✅ Orama hybrid + rerank, lexical fallback |
| T6 backfill re-embedding | ✅ done (Phase 4 Task 3) — "Re-index library" button in Settings → `REINDEX_LIBRARY` → `handleReindexLibrary` (`service-worker.ts`) walks every doc, re-chunks + re-embeds via offscreen, guarded against concurrent runs |
| T7 evict ephemeral chunks | ✅ `resetSessionIndex` in research `finally` |
| T8 persist research progress | ✅ exceeded — crash-safe job store + auto-resume |
| T9 academic agent resilience | ✅ retries + `s2ApiKey` honored — now has a Settings field too (Phase 4 Task 6 shipped it; no longer console-set only) |
| T10 README | ✅ |
| T11 stream research synthesis | ❌ open — backend streaming shipped (Phase 4 Task 5: `chatWithCustomStream` + `DEEP_RESEARCH_DELTA` broadcasts) but the sidepanel deliberately drops the deltas (perf regression froze the panel — see `App.tsx`'s `DEEP_RESEARCH_DELTA` handler comment); report still arrives as one block in the UI |

## Overview

Phase 4 closes the three Phase-3 leftovers (tests, embedding backfill, streamed
synthesis), fixes the known weakness of the just-shipped page-context feature
(long transcripts get middle-truncated at 16k chars), and adds the missing
`s2ApiKey` settings field. Nothing here changes architecture; it completes and
hardens what exists.

## Architecture Decisions

- **Tests target pure libs only** (`chunker`, `frontmatter`, `citations`,
  `research-store` helpers, `normalizeCitations`). No chrome-API mocking
  framework in this phase — worker/UI logic stays manually verified. Keeps the
  test floor cheap and stable against the parallel agent session.
- **Backfill reuses the exact save-time embed path** (offscreen
  `OFFSCREEN_GET_EMBEDDINGS`), batched per-document, progress over the existing
  BroadcastChannel toast pattern. Idempotent: skip chunks that already carry a
  384-length vector.
- **Long-page context switches from truncation to in-memory retrieval.** Page
  markdown > 16k chars → chunk with the existing chunker, embed in memory,
  cosine-rank against the user's question, inline top-k (~12k chars budget).
  Still zero IndexedDB / vector-store writes — cache the chunks+vectors in the
  same 5-min `pageContextCache` entry. ≤16k pages keep today's inline-whole path.
- **Synthesis streaming rides the existing research progress channel** (new
  `DEEP_RESEARCH_DELTA` message) rather than the chat port — research may outlive
  the panel; deltas are droppable, final message persists as today.
- **Coordination:** parallel agent session still edits this repo. Re-read every
  file before editing; keep tasks additive; commit per task.

## Task List

### Phase A: Test Foundation

#### Task 1: Vitest infra + chunker tests
**Status: DONE.** Verified `npm test` (52 files / 535 tests) and `npm run build`
both green; `src/lib/__tests__/chunker.test.ts` covers headings, anchor IDs,
paragraph splits, empty input, and the YAML-frontmatter regression case.
**Description:** Add `vitest` devDependency + `"test": "vitest run"` script +
`vitest.config.ts`. First suite for `lib/chunker.ts`: heading splits, stable
anchor IDs, paragraph splits, empty input, YAML-frontmatter input.
**Acceptance criteria:**
- [x] `npm test` green in `apps/extension`; `npm run build` unaffected
- [x] ≥6 chunker assertions incl. frontmatter regression case
**Verification:** `npm test`, `npm run build`.
**Dependencies:** None.
**Files:** `package.json`, `vitest.config.ts`, `src/lib/__tests__/chunker.test.ts`
**Scope:** S

#### Task 2: Frontmatter, citations, research-store tests
**Status: PARTIALLY DONE.** `frontmatter.test.ts` (quote/newline escaping, tag
normalization, `hasFrontmatter`), `citations.test.ts` (`stripCitations`,
malformed markers ignored), and `research-store.test.ts` (12h stale-job cutoff,
both sides) all exist and pass. `normalizeCitations` was NOT extracted out of
`ChatView.tsx` (still defined inline at `ChatView.tsx:303`) and has no test
covering the `[a, b, c]` → `[a][b][c]` comma-splitter.
**Description:** Suites for `lib/frontmatter.ts` (quote/newline escaping, tag
normalization, `hasFrontmatter`), `lib/citations.ts` (CITATION_REGEX parse,
malformed anchors ignored), `normalizeCitations` comma-splitter (extract to
`lib/citations.ts` if currently inline in ChatView so it's testable), and
`research-store` pure helpers (job age/staleness).
**Acceptance criteria:**
- [ ] `[a, b, c]` → `[a][b][c]` covered incl. mixed-validity brackets
- [x] Stale-job cutoff (12 h) covered both sides
**Verification:** `npm test`.
**Dependencies:** Task 1.
**Files:** `src/lib/__tests__/{frontmatter,citations,research-store}.test.ts`, possibly `src/lib/citations.ts`, `ChatView.tsx`
**Scope:** S

### Checkpoint A
- [x] `npm test` + `npm run build` green. Commit.

### Phase B: Retrieval Completeness

#### Task 3: Embedding backfill ("Re-index library")
**Status: DONE (implemented differently from spec).** `SettingsView.tsx:1238`
has a "Re-index library" button → `REINDEX_LIBRARY` message →
`handleReindexLibrary` in `service-worker.ts:1282`, which walks every doc,
re-chunks + re-embeds via offscreen, writes back with `replaceChunksForDoc`,
resets all session indexes, and streams `reindex-progress`/`reindex-complete`
over the `ai_research_assistant_import` BroadcastChannel (rendered as toasts in
`App.tsx:852-857`). Concurrent-run guard (`reindexRunning`) confirmed. Deviates
from the plan: it unconditionally re-chunks + re-embeds **every** doc every run
rather than skipping chunks that already carry a vector, so a re-run is not a
"0 chunks to embed" no-op — it still fully achieves the backfill goal.
**Description:** Settings → Storage section button. Worker handler iterates all
docs' chunks, embeds those without a valid 384-vector via offscreen, writes back
to IndexedDB, then `resetSessionIndex` for affected projects. Progress + done
toast via BroadcastChannel. Guard against concurrent runs.
**Acceptance criteria:**
- [ ] Pre-embedding docs get vectors; re-run is a no-op ("0 chunks to embed") — re-run re-embeds everything, not a no-op
- [ ] Hybrid retrieval now hits an old doc it previously missed (manual A/B) — not manually re-verified here
- [ ] Save/capture unaffected while backfill runs — not manually re-verified here
**Verification:** manual with an old imported doc; build clean.
**Dependencies:** Task 1 (floor exists), else none.
**Files:** `service-worker.ts`, `SettingsView.tsx`, `db.ts` (chunk update helper)
**Scope:** M

#### Task 4: Page-context retrieval mode for long pages
**Status: DONE — superseded.** The chunk+embed+cosine-rank retrieval described
below was built essentially as specced (`PageChunkEmb`, `pageContextCache`
chunks field, `PAGE_RETRIEVAL_BUDGET = 22000`, confirmed in git history), then
replaced by a different, more capable mechanism: the page is sent as
head(4K)+section-index, and the agentic tool loop (`agenticGather` in
`service-worker.ts`) exposes `read_section`/`search_page`/`read_lines` tools so
the model can pull any part of a long page on demand — not just a
pre-embedded top-k. `getPageContextStrategy()` defaults to `'agentic'`
(`service-worker.ts:2200`), so this is the default path today. The old
chunk/embed code is explicitly marked "Obsolete: replaced by …" in a comment at
`service-worker.ts:818`. Net effect (mid-video content no longer lost to
truncation) matches the task's intent via a different, already-shipped design.
**Description:** In `getPageContext`/`buildChatRequest`: markdown > 16k chars →
chunk (existing chunker), embed chunks once (cached in `pageContextCache` with
vectors), embed question, cosine-rank, inline top-k chunks (~12k char budget)
with `[... only the most relevant sections of the page are shown ...]` marker.
Small pages unchanged. Embedding failure → fall back to today's head+tail
truncation.
**Acceptance criteria:**
- [x] 2-hour YouTube transcript: question about mid-video content answered
      (today's truncation loses the middle) — via `search_page`/`read_section`/`read_lines`, not embedding retrieval
- [ ] Follow-up question on same page does not re-embed (cache hit, verify via log) — N/A, current mechanism does not embed at all
- [x] No IndexedDB or session-index writes from this path
**Verification:** manual on a long transcript + a short article; build clean.
**Dependencies:** None (parallel to Task 3).
**Files:** `service-worker.ts`
**Scope:** M

### Checkpoint B
- [ ] Backfill + long-page A/B documented in commit message. Commit.

### Phase C: Research UX

#### Task 5: Stream synthesis into chat
**Status: PARTIALLY DONE — backend shipped, UI rendering reverted.** The
backend half is real: `synthesisFn` in `service-worker.ts:3424` calls
`chatWithCustomStream` and forwards each delta as a `DEEP_RESEARCH_DELTA`
broadcast (with an idle-timeout watchdog + fallback to non-streaming on partial
failure). But the sidepanel's `DEEP_RESEARCH_DELTA` handler
(`App.tsx:621-628`) explicitly **drops every delta** — the comment there says
re-parsing the growing markdown report on each flush froze the panel, so "the
field log shows synthesis progress; the fully-rendered report lands via
loadChatHistory on DONE." So today the user still sees the report arrive as
one block (via the `[SYNTHESIZING]` log lines only), not incrementally — the
task's primary acceptance criterion is not met in the shipped UI.
**Description:** Synthesis LLM call switches to the SSE streaming helper;
deltas forwarded as `DEEP_RESEARCH_DELTA` broadcasts. Sidepanel renders a live
assistant bubble during `[SYNTHESIZING]`; on `DEEP_RESEARCH_DONE` the persisted
chat message replaces it (identical content). Panel closed → deltas dropped
harmlessly; checkpoint/resume semantics untouched (resume restarts synthesis).
**Acceptance criteria:**
- [ ] Report tokens render incrementally during synthesis — reverted; App.tsx intentionally drops DEEP_RESEARCH_DELTA
- [ ] Persisted message identical to streamed content; cancel keeps partial log state consistent
- [x] Panel closed during synthesis → run completes exactly as today
**Verification:** manual `/deepresearch` run; close/reopen mid-synthesis.
**Dependencies:** None technically; last — touches the two busiest shared files.
**Files:** `service-worker.ts`, `deep-researcher.ts`, `App.tsx`, `ChatView.tsx`
**Scope:** M

#### Task 6: `s2ApiKey` field in Settings
**Status: DONE.** Password-type input at `SettingsView.tsx:1022-1030`
("Semantic Scholar API key (optional)"), persisted via `saveResearchSetting`
to `chrome.storage.local.s2ApiKey`, read by `s2Fetch` in
`deep-researcher.ts:1196-1197` and sent as the `x-api-key` header. (README was
not updated to mention the new field.)
**Description:** Password-type input in Provider section, persisted to
`chrome.storage.local.s2ApiKey` (same key the agent already reads). Replaces the
console-only instruction; update README.
**Acceptance criteria:**
- [x] Key set via UI is sent as `x-api-key` on S2 requests
**Verification:** manual; build clean.
**Dependencies:** None.
**Files:** `SettingsView.tsx`, `App.tsx`, `README.md`
**Scope:** XS

### Checkpoint D — Complete
- [x] All tests green, build clean
- [ ] Manual smoke: capture → chat with citations → 📄 long-video chat → backfill → `/deepresearch` with live synthesis — not re-run here; note "live synthesis" doesn't currently render live in the UI (see Task 5)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Parallel agent session clobbers edits | High | Re-read before every edit; additive changes; commit per task |
| Backfill on large library hammers offscreen model | Med | Per-doc batching, sequential, progress visible, resumable by re-click (idempotent) |
| In-memory page embedding slow for huge transcripts | Med | Embed once per page (cached with vectors); fall back to truncation on failure |
| Vitest config clashes with vite multi-build setup | Low | Separate `vitest.config.ts`, tests limited to pure libs |
| Streaming deltas outlive/miss the panel | Low | Deltas droppable by design; persisted message is source of truth |

## Open Questions

1. In-page overlay chat (converse without opening sidepanel) — Phase 5 or drop?
2. Companion daemon for truly browser-independent research — separate project; want it scoped?
3. Backfill: auto-prompt once when zero-vector chunks are detected, or stay manual button only? (Plan assumes manual.)
