# Plan: minimal config, auto-tiered models, parallel research

Source: a 5-agent audit of all 38 `chrome.storage.local` keys against their real
read-sites (2026-07). Goal: **great defaults that work everywhere**, fewer knobs,
without losing capability.

Today: **1351-line Settings, 11 sections, 33 rendered controls, 38 keys.**
Target: **8 visible controls + 1 conditional + one collapsed `Advanced` (8 items).**
17 keys deleted outright; 6 struck from the inventory but kept as derived caches.

---

## 0. Bugs the audit found (fix FIRST — independent of config work)

These are correctness/security defects, not preferences. Verified against source.

1. **GitHub PAT is silently discarded.** `SettingsView.tsx:1069` renders a
   `GitHub PAT` input, but `github` is missing from the persist whitelist at
   `SettingsView.tsx:403` — the value is dropped on blur, and no reader ever
   sends it. Users type a real credential into a black hole. → delete the input
   (or wire it properly).
2. **Companion runs unauthenticated in every real deployment.** `companionToken`
   is READ and sent as `Authorization: Bearer` (`service-worker.ts:2620-2622`)
   but **nothing in the UI ever writes it**. `companion-mcp.js` warns a tokenless
   server "will run ANY shell command any local caller sends" — so that warning
   is the default state. → add the field + a Generate button
   (`generateCompanionToken()` in `settings.ts` is exported and never called).
3. **CLI-detection probe omits auth.** The `availableClis` probe doesn't send the
   bearer token, so against a token-protected companion it 401s, the list
   silently empties, and the user concludes the integration is broken.
4. **Jina privacy toggle doesn't cover the search path.** `jinaReaderEnabled`
   gates the reader (`r.jina.ai`) but NOT `jinaWebSearch` → `s.jina.ai`
   (`deep-researcher.ts:429`), which is gated only on "did the user set a Jina
   key". A user who flips the toggle off reasonably expects *no* Jina traffic;
   today their queries still go there if a key is present. → gate on
   `isJinaEnabled()` too.
5. **Error message points at a Settings field that doesn't exist**
   (`service-worker.ts:2624`).

---

## 1. Target shape

| Section | Controls |
|---|---|
| Workspace Instructions | rules textarea |
| AI Provider | Copilot sign-in/out · **API key** |
| Answering | web-fallback toggle · Jina toggle · **Chat backend** (Cloud \| Local CLI) · *(conditional)* companion token |
| Storage | Drive connect/disconnect · Force resync |
| **Advanced** (collapsed) | custom endpoint · context override · CLI template · manual location · S2 key · search API keys · MCP servers · GHES URL |

The model picker leaves Settings entirely — it already exists in the chat header,
which is where users actually switch models. It gains a free-text "custom…" entry
so providers without a `/models` endpoint stay usable.

Deleted sections: `capture`, `skills` (moves to Library + `/create-skill`),
`research` (all four dials derived), `research-apis` + `mcp` (fold into Advanced).

---

## 2. Auto-derivations (the "great defaults" core)

**Model trio → one model.** This is also the research-backed change (see §4):
tiering exists already (`classificationModel` is a lightweight scorer), it's just
*asked for* instead of *derived*.

- **`visionModel`** ← stored override ?? main model if vision-capable ??
  first vision-capable model in the catalog ?? main model.
  Regex: `/gpt-4o|gpt-4\.1|gpt-5|gemini|claude-3|claude-4|sonnet|opus|vision|-vl|llava|pixtral|qwen.*vl/i`
- **`classificationModel`** ← stored ?? same-vendor cheap sibling
  (`/mini|flash|haiku|small|lite|8b|-nano/i`) ?? `undefined` (= main model, today's
  behavior). Worst case slower/pricier, never broken.
- **`contextTokens`** ← stored ?? per-model `context_length` (keep the field the
  provider already returns — `llm-client.ts:293` currently throws it away, mapping
  to `m.id`) ?? static family table ?? 32768.
- **`customUrl` (first use only)** ← key-prefix sniff: `sk-or-*`→OpenRouter,
  `sk-ant-*`→Anthropic, `gsk_*`→Groq, `sk-*`→OpenAI. **MUST be gated on
  `!customUrl`** — overwriting a stored value would ship a proxy user's key to
  OpenAI.
- **`pageContextStrategy`** ← `(repoRef && isImplementationQuestion) ? agentic :
  semantic`. Drop the `router` branch (same plumbing, only differs in who picks).
- **`researchDepth`** ← run mode (`/research`→standard, `/deepresearch`+`/academic`
  →deep). Deep runs already floor to `.deep`, so the setting is a no-op for them today.
- **`sourceQuality`** ← `sourceMode === 'academic' ? 'high' : 'all'` — already
  computed and overwritten at `deep-researcher.ts:1792`.
- **`inferenceDevice`** → hardcode `wasm` (WebGPU fails: Chrome blocks dynamic
  `.mjs` import in offscreen workers — documented, not fixable here).
- **`mcpServers`** → auto-enable a local server when its `healthUrl` responds
  (the UI already polls it).

**Kept as overrides:** every derived key keeps its stored read, so existing
hand-tuned setups keep working. Removal is UI-only.

---

## 3. Parallel research runs (never landed — still `JOB_KEY` singleton)

Blockers are real, all verified:
- `research-store.ts:11` — ONE job under a global `JOB_KEY`; two runs stomp each
  other's resume checkpoint.
- `queueDraining` latch + `isResearchActive()` assume one run.
- `startJob()` calls `clearPages()` on the shared page cache — a second run would
  nuke the first's cache mid-flight.
- Heavy local inference (ONNX embed/rerank, parse worker) is **already
  serialized** per-call, so parallel runs' local work queues naturally. Keep that.

Design (cap 2):
1. Key jobs by project: `researchJob:${projectId}`; API becomes
   `getJob(projectId)` / `updateJob(projectId, patch)` / `listActiveJobs()`.
   One-time migration adopts the legacy `JOB_KEY`.
2. Scope the page cache by projectId (`${projectId}::${url}`) so `clearPages`
   keeps its "no cross-topic leak" property without touching the other run.
3. `MAX_CONCURRENT_RESEARCH = 2`; `isResearchActive()` → `activeResearchCount()`;
   drain starts runs while capacity remains; `resumePendingResearch` resumes ALL
   eligible jobs up to the cap.
4. Jitter (200-600 ms) between web fetches when >1 run is active.
5. Verify `guardHeapOrReload` — it reloads the whole extension, so BOTH runs must
   resume after it fires.

---

## 4. What the research reports actually give us

Three reports (intent routing, auto-model selection, chat SOTA). Honest triage:

**Adopt (one idea, and it's the config idea):** *budget-guided tiered routing with
a lightweight scorer* — pick the cheap model for classification/intent, the main
model for chat, the strong model for synthesis, **derived not configured**. That
is exactly §2's model-trio collapse. The reports' own warning applies to us:
*"avoid LLM-based routers when the downstream task is simple — the router's own
latency negates the savings"*, which validates keeping heuristic routing as the
default and deleting `chatRoutingMode`.

**Already doing (validated, no work):** agentic tool loops with external
grounding; persistent state/resume; uncertainty gating before trusting output
(our reranker faithfulness pass); RAG-first factual grounding; **tool count 3-4
per loop** — the reports find >50 tools degrades agents and 3-5 is optimal, so
we're in the good band.

**Not applicable (don't chase):** speculative decoding / lookahead routing (needs
inference-layer control; we call a remote API), IRT model mapping and
RouterDC/ICL-Router (need per-model benchmark training data), DPO/NSPO/RLHF
alignment (we don't train models), Mixture-of-Agents (cost).

---

## 5. Ordered steps (each independently shippable)

1. **Bug fixes from §0** (security/correctness; no config change).
2. Delete unreachable keys: `showWebSources`, `chatRoutingMode`, `copilotApiUrl`,
   `localMcpCompanionUrl`, `byok` (+ dead `linkedPagesFooter`, `decideRouteAgentic`).
3. De-dupe rendered controls + create the `Advanced` container.
   **Three literal duplicates exist:** `classificationModel` rendered twice
   (`:593`, `:684`), `enterpriseGitHubUrl` rendered in both auth branches
   (`:164-175`, `:182-192`), `customModel` in both Settings and the chat header.
4. Model-trio auto-derive (§2) + retain `context_length` from `/models`.
5. `inferenceDevice` → hardcoded wasm.
6. Chat-routing merge (one `Chat backend` control) + `pageContextStrategy` derive.
7. Research dials derived; delete the `research` section.
8. **`driveFolderName` migration in its own commit, BEFORE hardcoding** (see §6).
9. Capture + sidepanel (`autoLinkCaptures` on; `sidePanelOpen` storage→Map in a
   single commit covering both writers and the reader).
10. `customSkills` UI moves to Library (needs delete-from-Library first).
11. `academicDepth` — only after runtime OOM degradation lands; else demote.
12. Inventory cleanup (docs) — mark derived caches "do not delete".

**Parallel research (§3) is independent** and can land at any point.

---

## 6. Top risks

- **`driveFolderName` can orphan a user's corpus.** A user who renamed the folder
  is protected only by the `driveFolderId` cache — which Force Resync clears on
  every run. After that, `ensureFolder` looks for `name='Magpie'`, misses, creates
  a fresh empty folder, and **reports success** while the real corpus sits
  orphaned. Ship the rename migration first, verify, hardcode later.
- **`academicDepth` is a crash workaround, not a preference** — removing it before
  runtime degradation exists reintroduces OOM on low-RAM machines.
- **`companionToken` must gain a control, not lose one** (§0.2).
- **Search API keys must stay reachable** — without them the pipeline silently
  drops to the DDG anti-bot scrape chain and result quality collapses with no error.
- **Derived-key regressions are silent by nature.** Every derivation keeps its
  stored override read, and each step ships alone so a bad derivation is
  bisectable.
