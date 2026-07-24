# Deep Research: speed plan + the watchdog failure

From a six-probe investigation of `deep-researcher.ts` (47 findings, all
`file:line`-verified). Ordered by speedup ÷ (risk × effort).

**Headline:** a deep run is ~55-65% serial LLM generation, ~25-40% web fetch,
~10-25% ONNX rerank. The single biggest lever is **not** parallelism — it's
that `rounds` was deliberately doubled 4 → 8 for report quality (§0), while the
early-exit that was supposed to make that affordable almost never fires. So
every run pays all 8 stages even when the topic saturated at stage 3.

Estimates below are arithmetic on call counts and code-stated targets, **not
measured**. §1.0 adds the instrumentation to replace them with real numbers.

---

## Implementation status (2026-07-23)

| Item | Status |
|---|---|
| §1.1 delete double offscreen teardown | ✅ |
| §1.2 `scoreWebRefs` through the ONNX mutex | ✅ |
| §0b section-scoped revision + citation guards | ✅ |
| §2 graded early stop (coverage + novelty) | ✅ |
| §0 gather time budget (35 min → synthesize, don't abort) | ✅ |
| §4 link caps: `MAX_LINKS` 4, `MAX_SELECTED` 6, `FETCH_DEADLINE_MS` 15s | ✅ |
| §2b salvage truncated reflect JSON + novelty-only stop when reflect fails | ✅ |
| §1.0 instrumentation crumbs | ❌ next |
| §1.3 sliding window in `scrapeUrlList` | ❌ |
| §1.4-1.6 academic parallel discovery, dedup, S2 backoff | ❌ |
| §3.1 pre-filter search hits by title+snippet | ❌ |
| §3.2 drop per-section HyDE | ❌ |
| §6 correctness prerequisites (races, heap-guard granularity) | ❌ |

A field log showed the graded stop was unreachable on the path that needed it
most: it sat inside `if (r)`, so a stage whose reflect call returned nothing
("Reflect inconclusive") skipped the check entirely and ran the full depth.
§2b adds a novelty-only stop to that branch and retries a truncated
reflect response through `closeTruncatedJson()` before giving up on it.

`rounds 8 → 6` was deliberately **not** applied: the graded stop handles the
common case and the time budget bounds the worst case, so capping depth for
every topic is no longer the right trade.

---

## 0. The watchdog failure — CORRECTED diagnosis

My first read of this was **wrong on two counts**, and the corrections change
what needs fixing. Both mechanisms I proposed building already exist:

- **Per-call deadlines already exist.** `chatFn` wraps every research LLM call
  in `deadlineSignal(signal, LLM_CALL_TIMEOUT_MS)` where
  `LLM_CALL_TIMEOUT_MS = 4 min` (`service-worker.ts:3338, 3408-3415`). A single
  call **cannot** run 8 minutes — it's killed at 4 and the caller falls back.
  *"Kill slow calls earlier and use what's available" is already implemented.*
- **An unconditional keepalive already exists.** `service-worker.ts:3473`
  nudges `lastProgressAt` every 30s regardless of whether real progress
  happened. The **stall** branch therefore physically cannot fire on a
  slow-but-healthy run.

So the abort was almost certainly the **other** branch:

```ts
const overtime = Date.now() - runStartedAt > RESEARCH_MAX_WALL_MS;  // 60 min
```

The run wasn't stuck on one call. **It genuinely exceeded 60 minutes.**

### Why it got slow "now" — it's not a regression, it's a deliberate trade

`git log -L` on `research-limits.ts` shows deep mode's cost was **doubled on
purpose**, in two commits on 2026-07-15:

| | `rounds` | `totalSourcesCap` |
|---|---|---|
| Initial | 4 | 80 |
| "6 stages, revise-to-8 loop" | 6 | 120 |
| "bigger, more comprehensive reports — length mandate + more stages" | **8** | **160** |

That same change added the length mandate: *"the #1 failure of these reports is
being too SHORT. Target 1800–3000 words."* — so each of the now-8 stages also
generates more text than each of the old 4 did.

That's ~2× the sequential loop, ~2× the sources, and more output per call. A
run that used to finish in ~25 minutes now lands at ~50-60 — which is exactly
where the 60-minute ceiling starts cutting runs off. Nothing broke; report
quality was bought with wall-clock, and the bill came due at the cap.

### What to actually do

1. **Nothing about per-call timeouts or keepalives** — both exist and work.
2. **The graded early stop (§2) is now the whole fix**, not just an
   optimization. It's what lets a saturated topic stop at stage 4 while a
   genuinely broad one still gets 8. That recovers the pre-mandate speed
   *without* giving back the quality on topics that need the depth.
3. **Consider `rounds: 8 → 6` for deep** as an immediate one-line mitigation
   while §2 is built. Reverts half of that change's cost; `exhaustive` still
   offers 10 for when you want the maximum.
4. **Raise `RESEARCH_MAX_WALL_MS` 60 → 90 min only as a stopgap.** It stops the
   truncation but hides the problem — an hour-plus run is a bad experience even
   when it completes. Do §2 instead.

**Still worth doing** (unchanged, just not the root cause): make
`reflectOnStage` emit a patch rather than the whole regrown outline. At stage 8
that JSON is large, and a call killed by the 4-minute deadline loses the entire
stage's reflect output — the fallback path is a degraded run, not a free one.

---

## 0b. Long reports with NO citations — the revision stage, not faithfulness

Reported symptom: recent reports are very long and have **no links in any
section**. Investigated both final-phase suspects.

### Not guilty: `faithfulnessPass`
It *can* drop citations, and it once dropped 29/32 — but that incident produced
an explicit **miscalibration gate** (`deep-researcher.ts:2433`):

```ts
if (fr.dropped > 0 && fr.dropped <= Math.ceil(fr.total * 0.25)) { …strip… }
// otherwise: "check skipped — likely miscalibrated; keeping all citations"
```

It refuses to strip more than a quarter. It cannot produce a zero-citation
report. Cleared.

### Prime suspect: `reviseSynthesis` — a full rewrite, run up to twice

`evaluateAndRefine` (`:2404-2419`): `PASS_SCORE = 8` against a weighted
5-dimension rubric is a **high bar**, so revisions fire often. Each one calls
`reviseSynthesis`, whose prompt says:

> *"Rewrite the report to FULLY address these findings … **expand and
> restructure, don't just tweak**"*

An LLM doing a full expand-and-restructure rewrite drops most inline
`[anchor_id]` markers **even when told to preserve them** — the instruction is
there (`:2282`) but it competes with an explicit instruction to restructure.
And `MAX_REVISIONS = 2`, so it can happen twice, compounding.

This matches the symptom exactly: **rewrite → longer** (it's told to expand),
**newly generated prose → uncited**.

### Aggravating factor: the 24k truncation

`reviseSynthesis` feeds the model `synthesis.slice(0, 24_000)`. The code's own
comment (`:2172`) notes *"a 3000-word report is ~20k [chars]"* — so a report at
the top of the 1800–3000 word mandate is already near the cut, and a longer one
is silently truncated. The rewrite then **replaces the entire report** with an
expansion of only the part it saw, discarding the tail and its citations.

### Fix — section-scoped revision (this is §3.3, promoted)

`sectionDrafts` are already checkpointed (`:3031`). A failing rubric dimension
should rewrite **only the flagged section**, leaving every other section
byte-identical — citations included. This:
- preserves citations everywhere the auditor didn't complain,
- removes the 24k truncation risk entirely (one section always fits),
- is *faster* (one section, not ~4000 tokens of whole-report rewrite).

Interim mitigations, in order of how quickly they help:
1. **Lower `PASS_SCORE` 8 → 7**, or require the auditor to name a *specific*
   section before revising at all. Fewer revisions = fewer chances to lose
   citations. One-line change.
2. **Re-run `linkifyReportCitations` awareness**: any anchors the rewrite *did*
   keep still get linkified at save. It's the dropped ones that are gone for
   good — there is no recovery pass.
3. Raise the 24k slice to match the real report size, as a stopgap only.

### How to confirm in one run

The pipeline already logs the citation count. In the field log look for:
`[FAITHFULNESS] all N citations verified` (pre-revision count) and then check
the saved report. If N is healthy but the final report has none, the revision
is confirmed as the culprit. If N is already 0, the loss is upstream in
section synthesis instead and this section is wrong.

---

## 1. Free wins — no quality tradeoff, no memory risk

### 1.0 Instrument first (30 min, pays for itself)
Add one `crumb()` per stage recording: elapsed ms per phase (search / scrape /
index / reflect), rerank pair count, and `{docs indexed} vs {docs contributing
a chunk to synthesis}`. Every estimate below becomes a fact, and you'll know
whether rerank is 10% or 40% before optimizing it.

### 1.1 Delete the double offscreen teardown — **verified**
`deep-researcher.ts:3425-3426`:
```ts
recycleOffscreenWorker();              // terminate + respawn inference worker
await recreateOffscreen().catch(...);  // …then tear down the whole document
```
The recreate destroys the document *including* that worker. The recycle's
terminate + respawn + **model re-warm** is pure waste — and it happens at every
one of ~7 stage boundaries. Delete line 3425.

### 1.2 `scoreWebRefs` bypasses the ONNX mutex — **1 line, lowers peak memory**
`deep-researcher.ts:1980` calls `chrome.runtime.sendMessage({action:'OFFSCREEN_RERANK'})`
directly instead of `sendToOffscreen(...)`, escaping the serialization every
other rerank respects. Fix before any concurrency work — it's a prerequisite
for §3.1.

### 1.3 Sliding window instead of batch barrier
`scrapeUrlList` (`:1077-1082`) processes 20 URLs in fixed batches of 5 and
`Promise.all`s each batch — so every batch waits for its slowest member, and
one dead URL (up to 45s through the Jina→local ladder) stalls four healthy
ones. `followReferences` (`:2019-2049`) already implements the correct
sliding-window pool; copy that shape. **Same concurrency, same memory** — just
no head-of-line blocking.

### 1.4 Academic API discovery: 9 serial calls → 1 wall-clock wait
`runAcademicAgent` queries 3 providers × 3 queries strictly sequentially before
processing any paper. `Promise.allSettled` over the 9 pairs, keeping the 250ms
stagger that protects Semantic Scholar's keyless pool.

### 1.5 Stop re-fetching the same sources
- `followReferences` never writes to the page cache → refs re-fetched next stage.
  Add the `savePage(...)` call `scrapeUrlList:1092` already makes.
- The academic path downloads + parses an arXiv PDF **before** checking whether
  the doc already exists. Call `findExistingDocumentByUrl` first.
- `fetchArxivFullText` never consults the page cache at all.

### 1.6 Semantic Scholar backoff when a key is set
The keyless 429 ladder burns up to 10s of sleep per call. When `s2ApiKey` is
present that limit doesn't apply — skip the ladder, and honor `Retry-After`
when supplied.

---

## 2. The big lever: make the early exit actually fire

`deep-researcher.ts:3341` stops the gather loop only when **`thin === 0`** —
i.e. *every* outline section reaches adequate/rich. One stubborn section keeps
all 8 rounds running. Stages 4-8 are ~45-50% of a run.

**Fix — graded stop, two independent signals must agree** (so one noisy model
judgment can't end a run early):
```ts
stage >= 3 && thinRatio <= 0.25 && novelDocsThisStage === 0
```
- `thinRatio = thin / outline.sections.length` — tolerate one stubborn section.
- **novelty**: `uniqueStageDocIds.filter(d => !gatheredDocIds.has(d)).length`.
  Both sets already exist (`:3191`, `:3302`). A stage that found nothing new
  will not find something new next round either.

Expected: typical runs end at stage 4-5 instead of 8. **Quality tradeoff:
real but small** — the sections that stop early are the ones already marked
adequate/rich by the model's own outline status. Ship it behind the crumb from
§1.0 so you can compare report scores before/after.

Related: the "no new sources" detector is fail-closed — when `reflectOnStage`'s
JSON fails to parse it falls back in a way that never signals saturation. Fix
that too, or the novelty signal is unreliable.

---

## 3. Cut work that never reaches the report

### 3.1 Pre-filter search hits before scraping — biggest gather win
`runWebAgent` collects ~70 candidate URLs with **title + snippet**, throws that
metadata away, and blind-scrapes 20 in arbitrary order. Instead: rerank all ~70
by `title + snippet` against the topic in **one** offscreen call, drop the
obvious misses, then scrape the best 20. Same 20 fetches — better 20.
*(Requires §1.2 first.)*

Estimated ~25-45% of gather wall-clock, and it **improves** report quality.

### 3.2 Drop per-section HyDE
`:2955` passes `hyde: true` to the section retrieval, costing one extra LLM
round-trip per section. The query is already `heading + keyTerms` — a strong
lexical query. Marginal recall gain for 6-8 serial calls.

### 3.3 Section-scope the revision
`evaluateAndRefine` rewrites the **entire report** up to twice. `sectionDrafts`
are already checkpointed (`:3031`) — a failing dimension should rewrite one
section, not ~4000 tokens.

---

## 4. Link traversal depth — your specific ask

**Correction: `MAX_LINKS = 2` is BREADTH, not depth.** True multi-hop depth
doesn't exist anywhere in the chat path — it is structurally capped at exactly
**one hop**. So "raise depth above 2" isn't a constant change; it's a feature.

Three things all cap this, and raising only one does nothing:

| Constant | Now | → | Note |
|---|---|---|---|
| `FETCH_DEADLINE_MS` | 8s | **15s** | **The actual binding constraint today** — the scraper's own primary path budgets 20s and empirically takes 10-13s, so at 8s you're timing out mid-fetch |
| `MAX_LINKS` | 2 | **4** | breadth |
| `MAX_SELECTED` | 4 | **6** | subtractive with files — on a repo page with 3 file matches, exactly **1** link is followed regardless of `MAX_LINKS` |

Ceiling: `TOTAL_CTX_BUDGET (40k) ÷ LINKED_PAGE_BUDGET (8k) = 5`. Anything above
~4-5 links is silently dropped — raise `TOTAL_CTX_BUDGET` to 60k first if you
want more.

**The catch: the default chat strategy is `agentic`, and `agenticGather`
ignores `MAX_LINKS` entirely.** For most turns, editing these constants changes
nothing. Real depth belongs there: after each tool round, harvest links from
newly-fetched page markdown and merge them into the catalog the model can pick
from (`service-worker.ts:2363`). That gives genuine A→B→C traversal within the
existing ≤3-round cap — the right place for this feature.

**Research path** (`refBudget`, 3 refs/stage on deep): raising it to 5 is one
divisor change (`:3280`) — **but `followReferences` is the only indexing path
with no heap guard, no event-loop yield, and no `totalSourcesCap` accounting.**
Add those first (copy `scrapeUrlList:1114-1121`) or you're widening the one
unguarded path into the OOM history.

---

## 5. Parallel research runs — still discard, and now for a better reason

The investigation found rounds are **genuinely sequential**: stage N's queries
come from stage N-1's reflect output. There is no cross-round parallelism to
harvest, so concurrency would only ever mean *two whole runs at once* —
doubling peak memory against three documented OOM classes.

And §§1-3 target roughly **2-3× on a single run**. A 40-minute run becoming
~15 means the queue ("🕓 Queued (position N)") stops being a annoyance. Fix the
one run; the need for two evaporates.

---

## 6. Correctness prerequisites (found en route — these gate the speed work)

1. **`addChunksToVectorStore` has a lost-update race** on `sessionChunkCount`,
   and it **already fires today** because `followReferences` runs 4 workers
   concurrently. Make the accounting atomic before adding concurrency.
2. **The mid-stage heap guard got 5× coarser** at some point — it used to run
   after every indexed source, now after every batch of 5, and reads an isolate
   the heavy work has since left. Move it back inside the per-source loop.
3. **Parse-worker recycle can orphan in-flight parses** from the same batch
   (30s stall + silent source loss). Defer recycle until `parsePending` is empty.
4. **`totalSourcesCap` is never enforced across stages in academic mode** —
   `/academic` can index ~280 papers against a nominal 160 cap. This is the
   multiplier on every academic cost above. Thread a run-scoped counter.
5. `chunkPoolCap` is **dead config** — tier-tuned, asserted in a test, read by
   no product code. The depth dial doesn't do what the tiers claim. Delete it
   or wire it.

---

## Suggested order

1. **§0** watchdog keepalive + reflect-as-patch — stops false failures *(you hit this today)*
2. **§1.0** instrumentation — replaces every estimate here with a measurement
3. **§1.1-1.2** double-teardown delete, mutex fix — minutes of work, one lowers memory
4. **§6.1-6.2** the two races/regressions — prerequisites, not optional
5. **§2** graded early stop — the single biggest win
6. **§1.3-1.6, §3.1-3.2** sliding window, dedup, pre-filter
7. **§4** link constants (chat) — cheap; the agentic-depth feature is separate
8. Re-measure. Decide on §3.3 and the §4 research-side bump with real numbers.
