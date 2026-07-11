# Implementation Plan: Ephemeral Page Context

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
- [ ] Returns markdown for article pages, YT transcripts, and PDF tabs
- [ ] Second call within 5 min for same URL does not re-scrape (log/verify)
- [ ] `captureTab` behavior unchanged (still saves/links as before)
**Verification:** build clean; manual: toggle on (after T4) over the three page types.
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
- [ ] With toggle on, model answers questions about page content it was never captured from
- [ ] Library citations still render as chips; no fabricated anchors for page content
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
- [ ] Streaming chat includes page context when flag set
- [ ] Non-http tab / scrape failure → chat still works, no crash
**Files:** `background/service-worker.ts`, `sidepanel/App.tsx` (send payload)
**Scope:** S

### Phase 2: UI

#### Task 4: Toggle chip in chat context bar
**Description:** ChatView context bar (next to "N SOURCES READY") gets a
toggle chip: favicon + truncated tab title, ON state styled like active nav.
State lifted to App (persisted in `chrome.storage.local`), current tab title
from existing `tabInfo`. Disabled/hidden when tab isn't http(s).
**Acceptance criteria:**
- [ ] Toggle persists across panel reopen
- [ ] Chip shows live tab title; switching tabs updates it
- [ ] Off = identical behavior to today
**Files:** `sidepanel/components/ChatView.tsx`, `sidepanel/App.tsx`
**Scope:** M

### Checkpoint
- [ ] Build clean; manual matrix: article / YouTube / PDF × toggle on/off ×
      with/without library sources. Commit.

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
