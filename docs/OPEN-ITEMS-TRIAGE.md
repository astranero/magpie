# Open Items — Triage (2026-07-23)

Every unfinished item across the plan docs, decided: **do it**, **defer it**, or
**discard it**. Written after a 23-agent doc audit verified each claim against
live code, so the inputs are real rather than what the plans assumed.

Two of the plan docs' own claims turned out to be wrong. Corrections are at the
bottom — read those before trusting the older docs.

---

## Verdict summary

| # | Item | Verdict | Why in one line |
|---|---|---|---|
| 1 | `package.json` 1.0.0 vs `manifest.json` 2.0.0 | **DO NOW** | Ships the wrong version number to the store |
| 2 | Rotate OpenRouter API key | **DO NOW** | Key passed through a chat transcript |
| 3 | `CHANGELOG.md` | **DO NOW** | Trivial, and every release needs one |
| 4 | Drive wrong-folder guard | **DO** | Silent duplicate-corpus bug (severity corrected — see §A) |
| 5 | `normalizeCitations` extract + test | **DO** | Zero coverage on the tool's core promise |
| 6 | Re-index idempotency | **DO** | Re-embeds the whole library every run — cost + OOM risk |
| 7 | `inferenceDevice` → hardcode wasm | **DO** | The WebGPU option is documented-broken; offering it is a trap |
| 8 | Keep `context_length` from `/models` | **DO** | Data is already fetched, then thrown away |
| 9 | Delete the research dials that lie | **DO** | Two of them are overwritten/no-op at runtime |
| 10 | `Advanced` collapsed container | **DO** | The whole point of the config-reduction plan |
| 11 | Header wordmark | **DO** | Bird mark is built and unused; ~30 min of polish |
| 12 | `sidePanelOpen` legacy path | **DO** | Half-finished migration, two sources of truth |
| 13 | Split `service-worker.ts` | **DEFER** | Mechanical and proven, but no user value — do it opportunistically |
| 14 | Split `App.tsx` / `deep-researcher.ts` | **DEFER** | Same, higher risk |
| 15 | Parallel research runs | **DISCARD** | Queue already handles this well; doubles memory on a 3× OOM-crash history |
| 16 | Live-streamed research report | **DISCARD** | Deliberately reverted for panel freeze; near-zero value on a 10–30 min run |
| 17 | Raise PDF cap to 50 MB | **DISCARD** | The cap is the OOM protection; fix the doc, not the number |
| 18 | PDF page-batch streaming (P3 half) | **DISCARD** | Same reasoning; no reported failures |
| 19 | `customSkills` → Library | **DISCARD** | Pure relocation, no user benefit, needs new delete UI first |
| 20 | Remove `academicDepth` | **DISCARD** | The plan itself says it's a crash workaround |
| 21 | Vision/classification model auto-derive | **DISCARD** | Regex-guessing a model silently picks a worse one; current fallback is already right |

---

## DO NOW — blocks a release

### 1. Version mismatch
`package.json` (root and `apps/extension/`) say `1.0.0`; `apps/extension/src/manifest.json`
says `2.0.0`. The manifest is what the store reads. Pick one, make them match,
and add a check so they can't drift again.

### 2. Rotate the OpenRouter API key
It passed through a chat transcript earlier in development. Rotate before the
repo or any build is shared. Not a code change — do it in the OpenRouter
dashboard, then update `e2e/.openrouter-key`.

### 3. `CHANGELOG.md`
Doesn't exist. The commit history is unusually descriptive, so a first entry is
mostly a summarization job, not archaeology.

---

## DO — real value, bounded effort

### 4. Drive wrong-folder guard *(severity corrected)*
`ensureFolder` (`service-worker.ts:3822`) resolves the sync folder by **cached
id first**, and only falls back to a name search when that id is missing. If the
user renamed the folder in Drive *and* the cached id is gone (reinstall, cleared
storage, trashed folder), the name search misses and it **creates a fresh empty
"Magpie" folder, then reports success** — the real corpus is left behind.

The fix is cheap and doesn't need the full migration the old plan describes:
before *creating* a folder, check whether any local document already carries a
`driveFileId`. If so, we've synced before and are about to sync somewhere new —
surface that instead of silently proceeding.

Do this **before** hardcoding `driveFolderName` (step 8 of the config plan), not
after.

### 5. `normalizeCitations` — extract and test
`ChatView.tsx:303`, zero test coverage. It rewrites grouped `[a, b, c]` citations
into individual `[a][b][c]` markers — i.e. it sits directly on the citation path
that the rest of this project treats as its most important guarantee, and it's
the only piece of that chain with no tests. Hoist it into `lib/citations.ts`
(where the sibling helpers already live) and cover the grouped/nested/malformed
cases.

### 6. Re-index idempotency
`handleReindexLibrary` re-chunks and re-embeds **every** document on every run,
even chunks that already have a vector. On a large library that's a long,
memory-heavy operation on a codebase with three documented OOM crash classes.
Skip chunks that already carry an embedding.

### 7. `inferenceDevice` → hardcode wasm
The Settings dropdown still offers WebGPU. It's documented as non-functional
(Chrome blocks dynamic `.mjs` import in offscreen workers). A setting that
breaks inference when selected is worse than no setting.

### 8. Keep `context_length` from `/models`
`llm-client.ts:293` maps the provider's model list to `m.id` and discards
everything else — including the `context_length` the provider already returned.
Retaining it removes the need for the user to ever set `contextTokens` by hand.
This is the genuinely free half of the "model trio" idea; see item 21 for the
half worth dropping.

### 9. Delete the research dials that lie
Two of the four are not honest controls today:
- `sourceQuality` is computed and **overwritten** at `deep-researcher.ts:1792`
- `researchDepth` is a no-op for deep runs, which floor to `.deep` regardless

Delete those two. Keep `academicDepth` (item 20) and re-evaluate the fourth once
the section is smaller.

### 10. `Advanced` collapsed container
The visible payoff of the config-reduction plan — ~33 controls down to ~9 with
the rest one click away. Do it **after** 7–9, so it collapses a shorter list.

### 11. Header wordmark
`MagpieMark` exists in `BrandMark.tsx` and is used nowhere. The empty-state
illustration is already wired up. Putting the mark in the header is small and
makes the panel look finished.

### 12. `sidePanelOpen` legacy path
The migration to an in-memory Map is half-done: the Map handles icon clicks, but
the Alt+M shortcut still goes through the old `chrome.storage.local` path
(`content.ts:748` → `service-worker.ts:377`). Two sources of truth for one piece
of state. Finish it or revert it; don't leave both.

---

## DEFER — worth doing, not now

### 13. Split `service-worker.ts` (4073 lines)
The pattern is proven — `llm-client.ts`, `library-handlers.ts`,
`document-handlers.ts`, `project-handlers.ts` were all extracted this way and
nothing broke. It's mechanical. It also **reduces merge conflicts between
parallel agent sessions**, which bit this project repeatedly.

But it's zero user-visible value and non-trivial churn. Do it opportunistically:
when a change lands in one domain, extract that domain's handlers with it.

### 14. Split `App.tsx` (2477) / `deep-researcher.ts` (3570)
Same argument, worse ratio. `deep-researcher.ts` in particular is dense
pipeline logic where a botched extraction is expensive. Opportunistic only.

---

## DISCARD — with reasons

### 15. Parallel research runs
*(Verdict unchanged, but the reasoning is now stronger — see
[`RESEARCH-SPEEDUP-PLAN.md`](RESEARCH-SPEEDUP-PLAN.md) §5. A six-probe
investigation found rounds are **genuinely sequential** — stage N's queries come
from stage N-1's reflect output — so there is no cross-round parallelism to
harvest at all. Concurrency could only ever mean two whole runs at once. And the
speedups in that plan target 2-3× on a single run, which makes the queue a
non-issue.)*

The plan designs a concurrency cap of 2. Recommend **not building it**:

- **The queue already solves the user problem.** A second `/deepresearch`
  enqueues and reports *"🕓 Queued (position N) — this research will start
  automatically when the current run finishes."* (`service-worker.ts:3294`).
  That's a good experience, not a failure mode.
- **The cost is wall-clock time on a background task** the user isn't watching.
- **The risk is memory.** This project has three separate documented OOM crash
  classes (MV3 worker cap, offscreen heap ratchet, sidepanel payload). Running
  two research pipelines concurrently doubles peak pressure on the exact system
  that already crashes with one.

If throughput ever genuinely matters, revisit — but make one run bulletproof
first. The design in `CONFIG-REDUCTION-PLAN.md` §3 stays on file.

### 16. Live-streamed research report
Counted as an unmet criterion in **three** plan docs, which makes it look like a
gap. It isn't — it was built, then **deliberately reverted**
because live-rendering froze the panel. `App.tsx:621` drops the deltas on
purpose and says so.

The value is genuinely low: a deep run takes 10–30 minutes with live log-line
progress throughout; streaming would add feedback only for the final seconds.

*(Noted for completeness: the freeze is now a solved problem — buffer tokens and
flush at a fixed paint cadence rather than per token, and don't re-parse partial
markdown. So this is doable correctly if it's ever wanted. It just isn't worth
the reopening.)*

**Action: mark it "won't do" in all three docs** so it stops reading as debt.

### 17–18. PDF: raise the 30 MB cap / page-batch streaming
`MAX_PDF_URL_MB = 30` (`offscreen.ts:359`) is what makes the plan's "50 MB arXiv
PDF captures successfully" criterion false. But the cap **is** the OOM
protection, the error is clear (*"PDF too large to parse safely (X MB)"*), and
there are no reported failures from it. Raising it trades a clean rejection for
a possible crash.

**Action: amend the acceptance criterion to match the shipped cap.** Same
reasoning discards the unbuilt page-batch streaming half of P3.

### 19. `customSkills` → Library
A relocation with no user-facing benefit, and it needs a delete-from-Library
flow built first. Settings is a defensible home for it.

### 20. Remove `academicDepth`
`CONFIG-REDUCTION-PLAN.md` §6 says it plainly: it's a crash workaround, not a
preference, and removing it before runtime OOM degradation exists reintroduces
OOM on low-RAM machines. Keep the setting.

### 21. Vision / classification model auto-derive
The plan would pick `visionModel` and `classificationModel` by regex-matching
model names (`/mini|flash|haiku|small|lite|8b/`, `/gpt-4o|gemini|claude|vision/`).

Recommend **not** doing this. Today's fallback — unset means "use the main
model" — is already correct and never surprising. A regex guess that fires wrong
silently routes work to a worse model, and model naming changes constantly, so
the regex rots. It saves one optional field at the cost of a silent failure mode.

Keep item 8 (`context_length`, which is real data from the provider) and drop
the guessing.

---

## Corrections to existing plan docs

**A. `CONFIG-REDUCTION-PLAN.md` §6 overstates the Drive risk.** It claims the
`driveFolderId` cache "Force Resync clears on every run." It does not —
`resetSyncStatus` (`db.ts:991`) only resets per-document `syncedToDrive` /
`driveFileId` flags and never touches `driveFolderId`. The real trigger is
narrower (renamed folder **plus** a lost cached id), and the outcome is a
duplicate/orphaned corpus rather than destroyed data. Still worth the guard in
item 4; not the emergency it was written as.

**B. `PLAN-v1-full.md` D2 cited the wrong CI filename** — `.github/workflows/ci.yml`
vs the actual `verify.yml`. Already fixed in the doc-alignment commit.

**C. Three docs count live-streamed synthesis as incomplete work.** It's a
deliberate product decision (item 16), not an unfinished task.

---

## Addendum — deep-research speed (2026-07-23)

The user asked to speed up `/deepresearch` and `/academic`, and to raise page
traversal depth. Both are planned in
[`RESEARCH-SPEEDUP-PLAN.md`](RESEARCH-SPEEDUP-PLAN.md). Two findings that
correct assumptions in this file and elsewhere:

- **`MAX_LINKS = 2` is a BREADTH limit, not depth.** True multi-hop traversal
  doesn't exist in the chat path — it's structurally capped at one hop. And the
  default strategy (`agentic`) ignores `MAX_LINKS` entirely, so editing the
  constant changes nothing for most turns. `FETCH_DEADLINE_MS = 8s` is the
  actual binding constraint.
- **A live `/deepresearch` run died to the watchdog during this session.** Not
  slowness — non-streamed LLM calls emit no progress while in flight, so a
  single slow `reflectOnStage` generation tripped the 8-minute stall abort on a
  healthy run. Fixing that is §0 of the speedup plan and outranks everything
  here.

---

## Suggested order

1. Items 1–3 (version, key, changelog) — an hour, unblocks releasing at all
2. Item 4 (Drive guard) — before any `driveFolderName` hardcoding
3. Items 5–6 (citation test, re-index) — correctness on the core promise
4. Items 7–9, then 10 (`Advanced`) — config reduction, in that order
5. Items 11–12 — polish
6. Mark 15–21 closed in their docs so the backlog stops lying about its size
