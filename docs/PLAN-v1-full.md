# Full Plan to v1.0 — Magpie

> Companion to root `MASTER_PLAN.md` (the other agent session's tracker).
> This plan supersedes `PLAN-phase-4.md` for sequencing. Coordinate: both
> sessions edit the same repo — re-read files before editing, one tranche
> per commit, tick items in BOTH docs.

## Overview

Everything user-visible is built. What stands between here and a trustworthy
v1: (A) the test suite was partly machine-generated and must be *audited*,
not just green; (B) three known correctness/perf leftovers; (C) three files
carry most of the code and tax every change; (D) no E2E/CI safety net;
(E) ship mechanics.

## Architecture Decisions

- **Green ≠ correct.** At least one existing test asserted a bug as spec
  (chunker "Document" heading — comment literally said "adjust test to match
  behavior"). The audit phase treats every suite as untrusted input.
- **Audit method is mutation spot-checks**, not review-only: break the
  implementation on purpose; a suite that stays green is a broken suite.
- **Refactor before identity/polish.** Every later task pays the
  1,400-line-`App.tsx` tax; splitting first makes everything after cheaper.
- **E2E over more unit tests.** Today's citation-offset bug was invisible to
  unit tests by construction (coordinate mismatch between two modules).

## Task List

### Phase A — Test Audit (the "bad model wrote these" pass)

#### A1: Red-flag sweep + contract review ✅ (docs/TEST-AUDIT.md)
**Description:** For each suite (`chunker`, `citations`, `content-cleaner`,
`frontmatter`, `frontmatter-parse`, `quality-gate`, `bibtex`, `paper-rank`,
`research-store`, `semaphore`, `commands`, `mcp-client`, `deep-researcher`,
`scrape-fallback`): (1) grep for confession comments ("match behavior",
"reflect reality", "adjust test"); (2) check each `expect` against the
module's *contract* (doc comment / caller expectations), not its code;
(3) flag tautologies (test recomputes the same formula as the impl) and
over-mocked tests where the mock IS the logic.
**Acceptance criteria:**
- [ ] Written verdict per suite: sound / weak / wrong, in `docs/TEST-AUDIT.md`
- [ ] Every "wrong" assertion rewritten against the contract
**Verification:** `npm test` green after rewrites; audit doc committed.
**Dependencies:** none. **Scope:** M

#### A2: Mutation spot-checks ✅ (8/8 killed after fixes; 154 tests)
**Description:** Temporarily break 8 load-bearing behaviors, one at a time,
confirm at least one test fails, revert. Targets: `RERANK_MIN_SCORE` sign
flip; `MIN_CHUNK_CHARS`→0; `CITATION_REGEX` anchor shape; one `BOT_PATTERNS`
entry removed; `makeBibKey` year dropped; `paperQualityScore` velocity term
removed; `sanitizeCustomSkill` shadow-check removed; `JOB_MAX_AGE_MS`→0.
**Acceptance criteria:**
- [ ] Kill-matrix table in `docs/TEST-AUDIT.md` (mutation → which test died)
- [ ] Every surviving mutation gets a new test that kills it
**Verification:** all mutations reverted, suite green. **Dependencies:** A1. **Scope:** M

### Checkpoint A — suite is trustworthy. Commit.

### Phase B — Correctness/perf leftovers

#### B0: Metadata rendered-by-default ✅ (done 2026-07-11)
Frontmatter always shows as the aligned metadata card (fixed label column,
humanized dates/word counts, tag pills, `created` deduped). Raw markdown is a
tiny "raw" link inside the card header, not a top-level mode button — users
never see YAML unless they ask for it.


#### B0.5: Library search ✅ (done 2026-07-11)
Search bar in the Lore view: instant title filter + debounced semantic search
over every stored document (hybrid BM25+vector+rerank via a `__library__`
index session). One hit per doc with snippet; clicking opens the document at
the matching passage (anchor highlight). Deletions reset the library index.

#### B1: Long-page context retrieval (P4-T4) ✅
Page markdown >16k chars: chunk + embed in memory (cached in
`pageContextCache`), cosine-rank against the question, inline top-k (~12k
budget). No IDB writes; embed failure → current head+tail truncation.
- [ ] 2-hour transcript: mid-video question answered; cache hit on follow-up
**Scope:** M

#### B2: Re-index library button (P4-T3 + re-chunk) ✅
Settings button → worker walks all docs: re-chunk with current chunker
(old docs predate noise/table filters), embed chunks lacking vectors,
`resetSessionIndex`. Progress via BroadcastChannel; idempotent; concurrent-run
guard. **Note:** re-chunking changes anchor IDs → old chat citations to those
docs will fall back to the "[CITED] position not found" callout; disclose in
the confirm dialog.
- [ ] Old imported doc becomes hybrid-retrievable; junk chunks gone
**Scope:** M

#### B3: Stream research synthesis (P4-T5) ✅
Synthesis via SSE helper; `DEEP_RESEARCH_DELTA` broadcasts; live bubble
during `[SYNTHESIZING]`; persisted message replaces it on DONE; panel-closed
runs unaffected; resume restarts synthesis cleanly.
- [ ] Tokens render live; persisted text identical
**Scope:** M

#### B4: Staged (Gemini-style) deep research ✅ (done 2026-07-11)
Deep mode gathers in stages (2/4/6 by depth tier): stage 1 = full agent
fan-out; each later stage runs LLM gap-analysis over evidence-so-far and
issues new web queries targeting only the gaps. Analyst notes feed synthesis.
New "Source quality" setting: All vs High-authority-only (domain allowlist +
DOI/arXiv + ≥10-citation floor on papers, with starvation guard).
Also from external research review: relative rerank score-cliff (tested) and
navigator.storage.persist() so Chrome can't evict the library under disk
pressure.

### Checkpoint B — remaining known gaps closed. Commit.

### Phase C — Structure (velocity refactor)

#### C1: Split `App.tsx` (~1,400 lines) 🟡 SLICE DONE
> Pure helpers → lib/format.ts + lib/import-helpers.ts (1517→1436). Hook
> extraction of the state machines still pending — needs richer E2E first.
Extract: `hooks/useChatStream.ts`, `hooks/useResearchState.ts`,
`hooks/useSettings.ts`, view wiring stays in App. No behavior change.
- [ ] App.tsx < 500 lines; build + tests green; manual smoke unchanged
**Scope:** L (mechanical)

#### C2: Split `service-worker.ts` (~1,900 lines) 🟡 SLICE DONE
> LLM client (getProviderSettings + chat + stream + models) → background/
> llm-client.ts, guarded by e2e/chat.spec.ts. Capture/import/research handler
> extraction pending — those handlers still lack E2E coverage.
`background/router.ts` (message map) + `background/capture.ts` +
`background/chat.ts` + `background/research-jobs.ts`. Keep exports stable.
- [ ] Worker file < 400 lines; zero dynamic imports in dist (MV3 rule)
**Scope:** L (mechanical)

#### C3: Extract research agents
`background/agents/{web,academic,news,mcp}.ts` from `deep-researcher.ts`.
- [ ] deep-researcher < 500 lines; tests untouched and green
**Scope:** M

### Checkpoint C — same behavior, files navigable. Commit per split.

### Phase D — Safety net

#### D1: Playwright E2E smoke ✅ (5 tests: smoke + chat streaming loop)
Launch Chromium with the built extension; script: open sidepanel → capture a
fixture page → ask a question → assert a citation chip renders → click it →
assert DocumentView opens with highlight. Run against `dist/`.
- [ ] `npm run test:e2e` green locally; catches coordinate-space class bugs
**Scope:** L

#### D2: GitHub Actions CI ✅ (.github/workflows/ci.yml)
`test` + `build` + `test:e2e` (headless) on push/PR. Cache node_modules.
- [ ] Red X on broken PRs
**Scope:** S

### Phase E — Ship

- **E1** MV3 persistence blog post (skeleton exists in
  `docs/MV3-PERSISTENT-AGENT-STATE.md`; war story = the 5-min resume loop). S
- **E2** Magpie identity pass (bird mark, wordmark, empty-state illustration,
  copy voice audit) — after C, so strings live in fewer files. M
- **E3** `CHANGELOG.md`, version bump, `dist/` zip, Chrome Web Store listing
  (+ Edge Add-ons — same package works). S

### Checkpoint E — v1.0 tagged.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Two agent sessions editing simultaneously | High | Tranche-per-commit; re-read before edit; tick both plan docs |
| Refactor (C) breaks subtle behavior | Med | Do after A+D1 so audit + E2E guard it — if C starts first, pull D1 earlier |
| Re-chunk invalidates old citation anchors | Med | Disclosed in B2 dialog; highlight already degrades gracefully |
| Mutation checks are manual, can be skipped | Med | Kill-matrix table is the deliverable — no table, task not done |

## Open Questions

1. E2E in CI needs headed-ish Chromium for extension loading — `xvfb-run` or
   Playwright's `chromium.launchPersistentContext` with `--load-extension`?
   (Spike in D1.)
2. Store listing: publish as "Magpie" — trademark check first?
