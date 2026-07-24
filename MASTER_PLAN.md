# MASTER PLAN — Magpie (née AI Research Assistant)

> **Status as of 2026-07-23**: Build ✅ | Tests 535/535 ✅ | 52 unit suites + 12 e2e specs | Committed locally, 9 commits ahead of `github.com/astranero/magpie` (not yet pushed)

---

## 📋 EXECUTIVE SUMMARY

| Metric | Status |
|--------|--------|
| **Build** | ✅ `tsc` + Vite × 3 configs clean |
| **Tests** | ✅ 535/535 unit passing (52 suites) + 12 Playwright e2e specs (smoke, chat, capture, citation-chips, live-*, render, research-plan, stream-finalize, memory-budget, link-preview) |
| **CI** | ✅ `.github/workflows/verify.yml` — build + typecheck + test on push/PR to `main` |
| **Git** | Local `main`, 9 commits ahead of `github.com/astranero/magpie` — push pending |
| **Copilot + BYOK coexistence** | ✅ Both provider catalogs live simultaneously; distinct model lists; asymmetric spend-confirm on switch |
| **Model selection** | ✅ One shared `ModelSelect` component (search + grouping + keyboard nav) used by every picker: Settings main/vision/fast models, the Copilot section, and the chat header |
| **Citation integrity** | ✅ `[[n](#cite:anchor)]` chips jump to the saved source chunk (not the external URL); number↔source alignment property-tested (40-trial fuzz) + 5-test e2e battery on real imported docs |
| **Debug-page detection** | ✅ ~20 log/crash/CI families recognized (Azure/GitHub/GitLab/Jenkins/CircleCI/docker, vitest/pytest/go test, Python/Java/Go/Rust/C# crashes, browser/node errors, kernel/k8s/systemd) via a single sampled pass |
| **`/teach` + `/grill`** | ✅ Ported from the `.opencode` coding-agent skills into in-product slash commands — lessons persist as workspace documents, mission lives in `project.rules` |
| **Config reduction** | 🟡 Steps 1–3 of `docs/CONFIG-REDUCTION-PLAN.md` done (5 security/correctness defects fixed, dead code removed, Settings de-duplicated); steps 4–12 (model-trio auto-derive, `driveFolderName` migration, Advanced container) open |
| **Free APIs** | ✅ 14 tiered APIs without keys |

---

## 🏗️ COMPLETED TRANCHES

| Tranche | Scope | Status |
|---------|-------|--------|
| **1 — Rebrand** | Magpie/Lore rename, `brand.ts` config, UI strings, manifest, README, PRODUCT/DESIGN docs | ✅ |
| **2 — Deep Research Fixes** | A/B/C fixes (content-type, heartbeat resume, arXiv full-text) | ✅ |
| **3 — Impeccable critique + fix pass** | P0–P3 UI fixes (CSS tokens, callouts, destructive actions, a11y) | ✅ |
| **4 — Test Suite Expansion** | 10 new test suites (research-store, mcp-client, commands, frontmatter-parse, academic refs, DOI, quality-gate, paper-rank, chunker, citations) | ✅ |
| **5 — Build Fixes** | Restored `research-store`, fixed tests, removed orphan `SourcesView`, fixed types | ✅ |
| **7 — Freeze/Performance Fixes** | F1–F9: streaming coalescing, rAF batching, plain-text streaming, batched embeddings, model preload, semaphore, batch IDB reads, scroll auto, memoized regex | ✅ |
| **8 — Deep Research Heartbeat** | Unconditional keepalive, phase-level wrappers, gathering-phase heartbeat | ✅ |
| **9 — Model Selector + Chat UX** | Restored model dropdown, model badge on all messages, `/cl` Enter fix, retry button | ✅ |
| **10 — Weather + Location** | Date/location in general-knowledge prompts, locale detection, weather misspelling catch | ✅ |
| **11 — GitHub Integration** | Enterprise GitHub URL setting, Copilot SSO device-flow auth, GHES `/api/v3` support | ✅ |
| **12 — DocumentView Polish** (was Tranche 2.5) | Metadata card (tags as chips, word count, capture date, source URL), highlight-offset coordinate-space fix (`stripFrontmatter` shared helper), BibTeX copy button, raw-markdown toggle | ✅ |
| **13 — Architecture Docs** (was Tranche 6) | All 8 docs written: `ARCHITECTURE.md`, `STORAGE.md`, `CAPTURE.md`, `RESEARCH-PIPELINE.md`, `CITATIONS.md`, `MCP.md`, `SKILLS.md`, `TESTING.md` — audited for accuracy this session | ✅ |
| **14 — SOTA Research Pipeline Upgrade** | Outline-driven synthesis (`reflectOnStage` co-evolution → `synthesizeSectionedPaper`), domain-authority ranking, epistemic rules, weighted eval rubric — see `docs/PLAN-v1-full.md` / `docs/PLAN-phase-4.md` | ✅ |
| **15 — Provider Onboarding + Clarity** | BYOK-first auto-configure, active-provider badge, enterprise GHES escape hatches, 5 audit-defect fixes (companion token auth, Jina privacy toggle, dead PAT field removed) | ✅ |
| **16 — Unified Model Selection** | Copilot/BYOK dual catalogs coexist; one shared searchable `ModelSelect` (Settings + chat header); asymmetric spend-confirm on cross-provider switch | ✅ |
| **17 — Citation Integrity Fix** | Numbered `[n]` citations resolve to the saved source chunk via `#cite:` links (previously threw the anchor away for a raw web URL); short-id-collision hardening; property + e2e test battery | ✅ |
| **18 — Debug-Page Detection Hardening** | ~20 log/crash/CI page families recognized; single sampled pass (head+tail) replaces a full-text scan for speed | ✅ |
| **19 — `/teach` + `/grill`** | Ported from coding-agent skills to in-product slash commands | ✅ |

---

## 🎯 REMAINING PLANS (PRIORITY ORDER)

> **Triaged 2026-07-23** — every open item below is decided (do / defer /
> discard) in [`docs/OPEN-ITEMS-TRIAGE.md`](docs/OPEN-ITEMS-TRIAGE.md), with
> reasons. Notably: parallel research runs and live-streamed reports are
> recommended **discarded**, not deferred. Read the triage before picking work
> from this list.

### 🟠 **Config Reduction — Steps 4–12** (MEDIUM)
> See `docs/CONFIG-REDUCTION-PLAN.md` §5 for the full ordered list. Steps 1–3 done.

| Step | Status |
|------|--------|
| 4. Model-trio auto-derive (`visionModel`/`classificationModel`/`contextTokens`) | ❌ |
| 5. `inferenceDevice` → hardcode wasm | ❌ |
| 6. Chat-routing merge into one control | ❌ |
| 7. Research dials derived; delete `research` section | ❌ |
| 8. **`driveFolderName` migration** (highest-risk item — Force Resync + rename can silently orphan a user's corpus) | ❌ |
| 9–12. Capture/sidepanel, `customSkills` → Library, `academicDepth` gating, inventory cleanup | ❌ |
| **Advanced** collapsed container (the visible payoff: ~33 controls → ~9 visible) | ❌ |

---

### 🔴 **Parallel Research Runs** (never started — designed, not built)
> Design lives in `docs/CONFIG-REDUCTION-PLAN.md` §3. Still a `JOB_KEY` singleton in `research-store.ts` — two concurrent `/deepresearch` runs stomp each other's checkpoint and page cache.

| Task | Status |
|------|--------|
| Key jobs by project (`researchJob:${projectId}`) | ❌ |
| Scope the page cache by projectId | ❌ |
| `MAX_CONCURRENT_RESEARCH = 2` + `activeResearchCount()` | ❌ |
| Jitter between concurrent web fetches | ❌ |
| Verify `guardHeapOrReload` resumes BOTH runs | ❌ |

---

### 🟠 **Tranche 3.5 — MV3 Persistence Blog Post** (MEDIUM)
> Content-writing task, not a code task — the pattern it documents (offscreen + IDB + heartbeat + alarms + resume gate) already shipped and is described in `docs/MV3-PERSISTENT-AGENT-STATE.md`.

| Section | Status |
|---------|--------|
| Cold open: 5-min resume loop war story | ❌ |
| Why MV3 makes this hard (SW lifecycle) | ❌ |
| The 5-part pattern | ❌ (documented in `docs/MV3-PERSISTENT-AGENT-STATE.md`, not yet adapted to blog voice) |
| What failed first (alarms-only, pure IDB, boolean-only) | ❌ |
| Testing recipes | ❌ |
| Cross-post to blog/HN | ❌ |

---

### 🟡 **Tranche 5 — Magpie Visual Identity** (LOW — mostly done)

| Asset | Status | Evidence |
|-------|--------|----------|
| Bird SVG mark (monochrome, perched on index card) | ✅ | `sidepanel/components/BrandMark.tsx` — `MagpieMark` |
| LoreView empty state: bird + index card illustration | ✅ | `BrandMark.tsx` — `MagpieEmptyIllustration` |
| PNG icons (16/48/128) for manifest | ✅ | `src/icons/icon{16,48,128}.png`, wired in `manifest.json` |
| Header wordmark "Magpie" + tagline | ❌ | Not found in `App.tsx` header |
| Copy voice audit (toasts, empty states, help text) | ❓ | Not verified this pass — needs a dedicated read-through |

---

### ⚪ **Deferred / External**

| Item | Owner | When |
|------|-------|------|
| `CHANGELOG.md` at repo root | Maintainer | v1 release |
| Push local commits to `github.com/astranero/magpie` | Maintainer | Whenever ready — nothing blocking |
| Rotate the OpenRouter API key (passed through an earlier chat session) | Maintainer | Before any public/repo-wide exposure |

---

## 📊 TECHNICAL DEBT / KNOWN GAPS

| Area | Severity | Notes |
|------|----------|-------|
| `service-worker.ts` — 4073 lines | **High** | Message router + domain modules needed; grew from ~4000 |
| `deep-researcher.ts` — 3570 lines | **High** | Agents as separate modules; grew from ~3500 |
| `App.tsx` — 2477 lines | **High** | Extract view components; grew from ~2200 |
| `free-apis.ts` — 547 lines | Low | Already modular; monitor growth |
| No request coalescing for parallel search calls | Low | Low priority |
| No retry/backoff on `chrome.storage.local` | Low | Rare failures |
| Parallel research runs | Medium | See above — designed, not built |

**Resolved since last update** (was listed as open, verified done this pass):
- ~~No E2E tests~~ — 12 Playwright specs exist (`e2e/*.spec.ts`)
- ~~No CI pipeline~~ — `.github/workflows/verify.yml` runs build+typecheck+test

---

## 🚀 NEXT ACTIONS (if you want to continue)

### Option A: Config reduction steps 4–12 (recommended)
```
1. Model-trio auto-derive (visionModel/classificationModel/contextTokens)
2. driveFolderName migration FIRST, then hardcode (highest-risk item — read
   §6 of CONFIG-REDUCTION-PLAN.md before touching)
3. Advanced collapsed container — the step with the visible payoff
```

### Option B: Parallel research runs
```
1. Project-keyed jobs (researchJob:${projectId})
2. Scoped page cache
3. Concurrency cap + resume-both-runs verification
```

### Option C: Ship v1.0
```
1. Rotate the OpenRouter API key
2. Push the 9 local commits
3. CHANGELOG.md
4. Tag v1.0.0
```

---

## 📝 QUICK REFERENCE — KEY FILES

| Area | Files |
|------|-------|
| Brand config | `src/lib/brand.ts` |
| Brand assets | `sidepanel/components/BrandMark.tsx` (`MagpieMark`, `MagpieEmptyIllustration`) |
| Research state | `src/lib/research-store.ts`, `deep-researcher.ts` |
| Free APIs | `src/lib/free-apis.ts` — 14 tiered search APIs |
| Copilot SSO | `src/lib/copilot-auth.ts` |
| Provider selection | `sidepanel/components/ModelSelect.tsx` — shared searchable picker used everywhere |
| Offscreen (embeddings/rerank/PDF/HTML) | `offscreen/offscreen.ts` |
| Chat streaming | `service-worker.ts` `chatWithCustomStream`, `App.tsx` `sendCommandOverStream`/`send` |
| Chat UI | `ChatView.tsx` `MessageBody`, `App.tsx` `messages` state |
| Document view | `DocumentView.tsx`, `LoreView.tsx` |
| Debug-page detection | `lib/log-highlights.ts` — `looksLikeDebugPage`, `extractLogHighlights` |
| `/teach` | `background/teach.ts` |
| Settings | `SettingsView.tsx` (MCP, custom skills, research depth, provider config) |
| Tests | `lib/__tests__/*.test.ts`, `background/__tests__/*.test.ts`, `sidepanel/components/__tests__/*.test.ts` |
| E2E | `e2e/*.spec.ts` (`smoke`, `chat`, `capture`, `citation-chips`, `render`, `research-plan`, `stream-finalize`, `memory-budget`, `link-preview`, `live-*`) |

---

## 🧪 VERIFY COMMANDS

```bash
cd apps/extension
npm test              # vitest run — 535 unit tests
npm run test:e2e       # playwright test — 12 specs (live-* need an OpenRouter key, skip cleanly without one)
npm run build          # tsc + Vite × 3
npm run dev             # hot reload for manual testing
```

---

**Decision point:** Config reduction steps 4–12, parallel research runs, or ship prep — pick a lane.
