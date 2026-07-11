# MASTER PLAN — Magpie (née AI Research Assistant)

> **Status as of 2025-07-11**: Build ✅ | Tests 137/137 ✅ | Tranche 7 (freeze fixes) **DONE**

---

## 📋 EXECUTIVE SUMMARY

| Metric | Status |
|--------|--------|
| **Build** | ✅ `tsc` + Vite × 3 configs clean |
| **Tests** | ✅ 137/137 passing |
| **Git** | 3 commits on `main` |
| **Freeze fixes (Tranche 7)** | ✅ F1–F9 complete |
| **Rebrand (Magpie/Lore)** | ✅ Complete |
| **Test suite** | 137/137 passing |

---

## 🏗️ COMPLETED TRANCHES

| Tranche | Scope | Status | Commit |
|---------|-------|--------|--------|
| **1 — Rebrand** | Magpie/Lore rename, `brand.ts` config, UI strings, manifest, README, PRODUCT/DESIGN docs | ✅ | 75341bb |
| **2 — Deep Research Fixes** | A/B/C fixes (content-type, heartbeat resume, arXiv full-text) | ✅ | (pre-history) |
| **3 — Impeccable critique + fix pass** | P0–P3 UI fixes (CSS tokens, callouts, destructive actions, a11y) | ✅ | (pre-history) |
| **4 — Test Suite Expansion** | 10 new test suites (research-store, mcp-client, commands, frontmatter-parse, academic refs, DOI, quality-gate, paper-rank, chunker, citations) | ✅ | 4a9f0f3 |
| **5 — Build Fixes** | Restored `research-store`, fixed tests, removed orphan `SourcesView`, fixed types | ✅ | 4a9f0f3 |
| **7 — Freeze/Performance Fixes (Tranche 7)** | **F1–F9 complete** — streaming coalescing, rAF batching, plain-text streaming, batched embeddings, model preload, semaphore, batch IDB reads, scroll auto, memoized regex | ✅ | 3bb109c |

---

## 🎯 REMAINING PLANS (PRIORITY ORDER)

### 🔴 **Tranche 2.5 — DocumentView Polish** (HIGH)
> **Effort:** ~2-3 hrs | **Impact:** High | **Depends on:** nothing

| Task | Status | Notes |
|------|--------|-------|
| Metadata card: tags as chips, word count badge, capture date, source URL | ❌ | `DocumentView.tsx` — replace raw frontmatter dump |
| Highlight offset fix for frontmatter-hidden view | ❌ | Current highlights computed against full content; need offset compensation |
| Copy-as-BibTeX button (uses existing `document.bibtex`) | ❌ | Already exists but not in metadata card |
| "View raw markdown" toggle (already in, verify) | ⚠️ | Verify offset math works when frontmatter hidden |

---

### 🟠 **Tranche 3.5 — MV3 Persistence Blog Post** (MEDIUM)
> **Effort:** ~4-6 hrs | **Impact:** External visibility | **Depends on:** nothing

| Section | Status | Target |
|---------|--------|--------|
| Cold open: 5-min resume loop war story | ❌ | Hook |
| Why MV3 makes this hard (SW lifecycle) | ❌ | Context |
| The 5-part pattern (offscreen + IDB + heartbeat + alarms + resume gate) | ❌ | Core |
| The 5-min resume loop war story + fix | ❌ | War story |
| What failed first (alarms-only, pure IDB, boolean-only) | ❌ | Lessons |
| Testing recipes (SW internals stop button, DevTools update-on-reload) | ❌ | Practical |
| Cross-post to blog/HN | ❌ | Distribution |

**Location:** `docs/MV3-PERSISTENT-AGENT-STATE.md` (skeleton exists)

---

### 🟠 **Tranche 5 — Magpie Visual Identity** (MEDIUM)
> **Effort:** ~6-8 hrs | **Impact:** Brand polish | **Depends on:** Tranche 2.5 (needs metadata card done)

| Asset | Status | Spec |
|-------|--------|------|
| Bird SVG mark (monochrome, 24×24, perched on index card) | ❌ | Header wordmark + favicon source |
| Header wordmark "Magpie" + tagline "Your research collector" | ❌ | `App.tsx` header |
| LoreView empty state: bird + index card illustration | ❌ | Replaces `Library` icon |
| Copy voice audit (all toasts, empty states, toasts, help text) | ❌ | "Terse librarian with a bird's-eye view" |
| PNG icons (16/48/128) for manifest | ❌ | External design pass |

---

### 🟡 **Tranche 6 — Architecture Documentation (Level B)** (LOW)
> **Effort:** ~4 hrs total | **Impact:** Maintainability/onboarding | **Parallelizable**

| Doc | Scope | Target Length |
|-----|-------|---------------|
| `ARCHITECTURE.md` | Top-level map: SW + offscreen + sidepanel + content script + IDB + Orama | ~500 words + 1 diagram |
| `STORAGE.md` | IDB schema, chunks/documents/chats, Orama index rehydration | ~800 words |
| `CAPTURE.md` | Web/PDF/YouTube/image/local file paths, quality gate, DOI fallback | ~600 words |
| `RESEARCH-PIPELINE.md` | Agents, planning, synthesis, checkpointing, resume | ~800 words |
| `CITATIONS.md` | Anchor grammar (`[d3.s2.p4]`), resolution, highlight mapping | ~500 words |
| `MCP.md` | Server config, tool discovery, Streamable HTTP transport | ~400 words |
| `SKILLS.md` | Command registry, custom skills, prompt skills | ~400 words |
| `TESTING.md` | How to run, what's covered, how to add tests | ~400 words |

**Location:** `docs/` (skeleton exists: `MV3-PERSISTENT-AGENT-STATE.md`, `PLAN-phase-3.md`, `PLAN-page-context.md`)

---

### ⚪ **Deferred / External**

| Item | Owner | When |
|------|-------|------|
| PNG icon assets (16/48/128) | External designer | Post-v1 |
| `CHANGELOG.md` at repo root | Maintainer | v1 release |
| Icons for `dist/` manifest | External | Pre-store |

---

## 📊 TECHNICAL DEBT / KNOWN GAPS

| Area | Severity | Notes |
|------|----------|-------|
| `App.tsx` ~1400 lines — extract view components | Medium | Candidate for extraction |
| `service-worker.ts` ~1900 lines — split handlers | Medium | Message router + domain modules |
| `deep-researcher.ts` ~1100 lines — extract agents | Medium | Agents as separate modules |
| No request coalescing for parallel search calls | Low | Low priority |
| No retry/backoff on `chrome.storage.local` | Low | Rare failures |
| No E2E tests (Puppeteer/Playwright) | Medium | High value for regressions |
| No CI pipeline (GitHub Actions) | Medium | Block on merge |

---

## 🚀 NEXT ACTIONS (if you want to continue)

### Option A: Tranche 2.5 next (recommended)
```
1. DocumentView metadata card + highlight offset fix
2. Copy audit pass (Tranche 5 copy audit table)
3. Then Tranche 3.5 blog post in parallel with Tranche 5 identity
```

### Option B: Polish pass
```
1. Clean up `App.tsx` (extract views)
2. Split `service-worker.ts` handlers
3. Add GitHub Actions CI
3. E2E smoke test (Playwright)
```

### Option C: Ship v1.0
```
1. PNG icons from designer
2. CHANGELOG.md
3. Tag v1.0.0
4. Chrome Web Store submission
```

---

## 📝 QUICK REFERENCE — KEY FILES

| Area | Files |
|------|-------|
| Brand config | `src/lib/brand.ts` |
| Research state | `src/lib/research-store.ts`, `deep-researcher.ts` |
| Offscreen (embeddings/rerank/PDF/HTML) | `offscreen/offscreen.ts` |
| Chat streaming | `service-worker.ts` `chatWithCustomStream`, `App.tsx` `sendCommandOverStream`/`send` |
| Chat UI | `ChatView.tsx` `MessageBody`, `App.tsx` `messages` state |
| Document view | `DocumentView.tsx`, `LoreView.tsx` |
| Settings | `SettingsView.tsx` (MCP, custom skills, research depth) |
| Tests | `lib/__tests__/*.test.ts`, `background/__tests__/*.test.ts` |

---

## 🧪 VERIFY COMMANDS

```bash
cd apps/extension
npm test          # 137 tests
npm run build     # tsc + Vite × 3
npm run dev       # hot reload for manual testing
```

---

**Decision point:** Which tranche next? (2.5 recommended)