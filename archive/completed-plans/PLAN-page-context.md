# Implementation Plan: Ephemeral Page Context

**Status: DONE.** All 4 tasks shipped (also confirmed in
`docs/PLAN-phase-4.md`'s "Status of previous plans" section). Evidence for
each acceptance criterion is inline below. Only the manual test-matrix
checkpoint item remains open — it's user acceptance, not code.

## Overview

A toggle in the chat that injects the **currently viewed page** into the
conversation context — scraped fresh, never saved to the library, never
indexed. Answers "chat about this page without capturing it." Works for
articles, YouTube watch pages (transcript), and PDFs, reusing the existing
scrape pipeline.

## Architecture Decisions

- **Ephemeral by definition**: page content lives only inside the single chat
  request. No IndexedDB writes, no vector-store inserts, no citation anchors
  (anchors only make sense for stored chunks the UI can open). The model is
  told to attribute page claims as "(from the current page)".
- **Scrape per message, cached briefly**: worker keeps an in-memory
  `url → {markdown, title, ts}` cache with a 5-minute TTL so multi-turn
  conversations about one page don't re-scrape (matters for PDFs, which are
  expensive to parse). SPAs that mutate content re-scrape after TTL.
- **Size guard, not retrieval**: Readability output is usually small. Inline
  up to ~16k chars; beyond that, truncate head+tail with a marker. Chunk+
  retrieve is overkill for one page and would drag the ephemeral content into
  the index we just cleaned up (T7).
- **Toggle state is global, persisted** (`chrome.storage.local.includePageContext`),
  shown in the chat context bar with the live tab title — user always sees
  exactly what will be included.
- **Coordination**: parallel agent session may touch the same files
  (service-worker, ChatView, App). Re-read before each edit; additive helpers
  preferred.

## Task List

### Phase 1: Worker — page context provider

#### Task 1: `getPageContext()` in service-worker
**Description:** Extract the scrape portion of `captureTab` into a shared
`scrapeActiveTab()` (content-script message + inject fallback + PDF path via
`pdfBase64ToBody`/Jina). New `getPageContext(): Promise<{title,url,markdown}|null>`
wrapping it with the 5-min in-memory cache. Never writes to DB.
**Acceptance criteria:**
- [x] Returns markdown for article pages, YT transcripts, and PDF tabs —
  `getPageContext()` (`background/service-worker.ts:823`) routes through
  `scrapeTabViaContentScript` (shared with `captureTab`, the plan's
  `scrapeActiveTab()`) for articles/YouTube, and `pdfUrlToBody`/Jina for PDFs.
- [x] Repeat calls for the same URL don't re-scrape within the cache window —
  `pageContextCache` + TTL check at `service-worker.ts:828-836` (TTL is
  `PAGE_CONTEXT_TTL_MS = 2 * 60 * 1000`, 2 min — tightened from the 5 min in
  this plan, plus a live-title staleness check for SPAs).
- [x] `captureTab` behavior unchanged (still saves/links as before) —
  `service-worker.ts:912-951` still calls `saveDocument` /
  `linkDocumentToProject` / `addChunksToVectorStore`; `getPageContext()` never
  touches these.
**Verification:** `tsc --noEmit` clean. build clean; manual: toggle on (after T4) over the three page types.
**Files:** `background/service-worker.ts`
**Scope:** M

#### Task 2: Inject into chat request
**Description:** `buildChatRequest(chatId, projectId, prompt, pageContext?)`
adds a clearly-scoped block when present:
`--- CURRENT PAGE (viewed by the user, NOT in their library) --- title/url/markdown`.
Prompt rule: cite library sources with anchors as before; attribute page claims
in plain text ("according to the current page"). Truncate >16k chars head+tail.
Works alongside or instead of RAG sources (page-only chat when library empty).
**Acceptance criteria:**
- [x] With toggle on, model answers questions about page content it was never
  captured from — `buildChatRequest` injects a `--- CURRENT PAGE ... ---`
  block (`service-worker.ts:1855-1895`); page content is never saved (only
  the in-memory `pageContextCache`), confirming it's answered without capture.
- [x] Library citations still render as chips; no fabricated anchors for page
  content — explicit prompt rule at `service-worker.ts:1894-1895`:
  "Attribute such claims in plain text... NEVER use [anchor] citations for
  current-page content — anchors are only for library sources."
  (Note: the >16k head+tail truncation described in this plan was superseded
  by a 4K head + section-index + agentic `read_section`/`search_page`/
  `read_lines` tool-loop — see `service-worker.ts:812-820, 1859-1881` and the
  "Selective enrichment" section below it. Same intent — bound what's inlined
  — implemented via retrieval instead of static truncation.)
**Verification:** manual A/B question answerable only from the page.
**Files:** `background/service-worker.ts`
**Scope:** S

#### Task 3: Wire through both chat paths
**Description:** Stream port `START` message and legacy `CHAT_WITH_KNOWLEDGE`
accept `includePageContext: boolean`; when true, worker calls `getPageContext()`
before building the request. Scrape failure degrades gracefully (proceed without
page, emit a system-visible note in the reply prefix? No — log only; UI toggle
shows tab title so user sees what was targeted).
**Acceptance criteria:**
- [x] Streaming chat includes page context when flag set — the chat-stream
  port's `START` handler reads `req.includePageContext` and calls
  `getPageContext()` before `buildChatRequest` (`service-worker.ts:2750-2752`);
  `sidepanel/App.tsx:1935-1941` sends `includePageContext` on every
  `port.postMessage({ type: 'START', ... })`.
- [x] Non-http tab / scrape failure → chat still works, no crash — both call
  sites wrap `getPageContext()` in `.catch(() => null)`
  (`service-worker.ts:550, 2750`), and `getPageContext()` itself returns
  `null` early for non-http(s) tabs (`service-worker.ts:826`).
  (Note: the legacy `CHAT_WITH_KNOWLEDGE` message path referenced in this
  task's description was removed entirely in a later refactor —
  `handleChatRemoved` at `service-worker.ts:561` now throws, and the
  chat-stream port is the only chat path. The "both chat paths" requirement
  is moot; the one remaining path is wired.)
**Files:** `background/service-worker.ts`, `sidepanel/App.tsx` (send payload)
**Scope:** S

### Phase 2: UI

#### Task 4: Toggle chip in chat context bar
**Description:** ChatView context bar (next to "N SOURCES READY") gets a
toggle chip: favicon + truncated tab title, ON state styled like active nav.
State lifted to App (persisted in `chrome.storage.local`), current tab title
from existing `tabInfo`. Disabled/hidden when tab isn't http(s).
**Acceptance criteria:**
- [x] Toggle persists across panel reopen — `App.tsx:1200` restores
  `includePageContext` from `chrome.storage.local` on mount (default ON);
  `togglePageContext` (`App.tsx:1520-1524`) writes it back on every toggle.
- [x] Chip shows live tab title; switching tabs updates it — `ChatView.tsx`
  chip (lines 874-895) renders `pageContextTitle`, wired from App's
  `tabInfo?.title` (`App.tsx:2277`), which `refreshTabInfo`
  (`App.tsx:454-473`) keeps in sync with the active tab.
- [x] Off = identical behavior to today — off means `includePageContext` is
  `false`, so `req.includePageContext` is falsy and `getPageContext()` is
  never called (`service-worker.ts:2750`), same as pre-feature behavior.
  Chip is hidden entirely (not just disabled) for non-http(s) tabs, since
  `tabInfo`/`pageContextTitle` is `null` there (`App.tsx:454-461`,
  `ChatView.tsx:874`).
  (Note: chip shows a 📄 emoji rather than the tab's actual favicon —
  cosmetic deviation from the plan's "favicon + truncated tab title"
  description; not an acceptance-criteria regression.)
**Files:** `sidepanel/components/ChatView.tsx`, `sidepanel/App.tsx`
**Scope:** M

### Checkpoint
- [x] Build clean — `tsc --noEmit` passes clean (verified during this audit).
      Feature is committed across multiple commits (`f126520`, `78808fa`,
      `5367f33`, `8b48982`, `430a08f`).
- [ ] Manual matrix: article / YouTube / PDF × toggle on/off ×
      with/without library sources. (User acceptance, not code — left open;
      same call made in `docs/PLAN-phase-4.md`'s "Status of previous plans".)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Parallel agent session edits same files | High | Re-read before edit, small sequential edits |
| Huge pages blow the context window | Med | 16k char cap, head+tail truncation marker |
| PDF scrape latency per message | Med | 5-min worker-memory cache |
| Model fabricates anchor citations for page text | Low | Explicit prompt rule + anchors impossible to resolve are already dropped by renderer |

## Open Questions
1. Should the assistant's reply visually badge "used current page"? (Default: no badge, keep simple.)
2. Multi-tab: only the active tab, or pin a specific tab? (Default: active tab at send time.)
