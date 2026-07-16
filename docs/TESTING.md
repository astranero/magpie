# Testing

## Running

```bash
cd apps/extension
npm test           # vitest — unit suites (src/**/__tests__)
npm run build      # tsc + vite × 3 (background, sidepanel, content/inject)
npm run test:e2e   # Playwright — loads dist/ into headless Chromium
```

CI (`.github/workflows/ci.yml`) runs all three on push/PR, workspace-aware.

## Unit tests (~382)

Pure-lib suites only, by policy: chunker, citations, content-cleaner,
frontmatter (+parse), quality-gate, bibtex, paper-rank, rerank-gate,
research-store, commands, mcp-client, doc-meta-index, reference-harvest,
format, semaphore, deep-researcher pure helpers, scrape-fallback. No
chrome-API mocking framework — worker/UI logic is covered by E2E instead.
Newer guard suites: outline (reflect parse/merge/trim), document-list
payload (frontmatter-only strip), research-concurrency (FIFO drain),
research-limits budget, weighted evaluator scoring.

**The suite was audited, not just kept green** (`docs/TEST-AUDIT.md`):
contract review per suite plus an 8-target mutation kill-matrix. Lessons
encoded there: untestable placement produces tautological tests (extract
the logic, then test it); redundant defensive patterns need per-pattern
isolation tests; composite scoring formulas need property assertions.

## E2E (Playwright, `e2e/`)

Loads the built extension via `chromium.launchPersistentContext` with
`--load-extension`; extension id read from the registered service worker.
One worker, no parallelism (global extension state).

- `smoke.spec.ts` — sidepanel mounts, bottom-nav switches views, chat empty
  state, command palette.
- `chat.spec.ts` — spins up an in-test **mock OpenAI-compatible SSE server**,
  points the extension at it via `chrome.storage`, sends a message, asserts
  the streamed reply renders (guards llm-client + stream port + delta
  rendering).
- `capture.spec.ts` — seeds a document via `IMPORT_LOCAL_MD` (no tab/picker
  needed), then drives the UI: library search finds it by content, clicking
  the hit opens DocumentView at the matched passage. Runs BM25-lexical when
  the offscreen embedding model is unavailable (deterministic in CI).
- `research-plan.spec.ts` — `/research` posts the in-chat plan card; the
  preview's no-LLM fallback still reaches an actionable draft, the input
  stays enabled while the plan is pending, and Cancel is terminal.

E2E exists specifically for the **coordinate-space / wiring class of bug**
(e.g. highlight offsets vs frontmatter stripping) that unit tests cannot
see by construction.

## Review rules (from dogfooding synthesis, 2026-07)

- **No silent awaits**: any user-triggered path that can take >1s (embedding
  cold-start, network, LLM call) must show visible progress — a pending row,
  status line, or spinner — and replace it in place with the result. A silent
  await reads as a dead feature (/recall was the live example).

## Adding tests

- New pure logic → put it in `lib/`, add a `__tests__` suite, and make sure
  a deliberate mutation of the behavior fails it.
- New UI/worker flow → extend an E2E spec; prefer message-API seeding over
  UI setup for fixtures.
- Live-provider E2E (`e2e/live-*.spec.ts`): real OpenRouter runs — chat
  streaming + process indication, /deepresearch plan card, vision import,
  bad-key negative; full research run behind `RUN_LIVE_RESEARCH=1`. Skips
  without a key (env `OPENROUTER_API_KEY` or gitignored
  `e2e/.openrouter-key`). Fresh browser context per test — a shared
  profile shares the persisted active chat and a leftover stream makes the
  next send silently queue.
- Memory-budget E2E (`e2e/memory-budget.spec.ts`): seeds a heavy corpus
  into the real IndexedDB and asserts the global LIST_DOCUMENTS payload
  ships frontmatter-only (the sidepanel-OOM regression guard).
- Not covered yet (known): PDF/image import via UI, page-context, MCP
  against a live server.
