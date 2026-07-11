# Magpie — Architecture

> Chrome MV3 extension: local-first research knowledge base with
> citation-grounded chat and multi-agent staged deep research.
> Component detail lives in `docs/` (STORAGE, CAPTURE, RESEARCH-PIPELINE,
> CITATIONS, MCP, SKILLS, SECURITY, TESTING).

## Execution contexts

MV3 forbids persistent background pages, so the extension is partitioned by
lifetime and capability:

| Context | Lifetime | Role |
|---|---|---|
| **Service worker** (`src/background/`) | Ephemeral (~30 s idle kill) | Message router, capture orchestration, chat/research lifecycle, checkpointing |
| **Offscreen document** (`src/offscreen/`) | Unbounded (`DOM_PARSER` reason) | Heavy compute: pdf.js parsing, HTML→markdown (Readability), embedding + reranker models (transformers.js) |
| **Content script** (`src/content/`) | Bound to tab | DOM scraping (Readability + Turndown), YouTube transcripts |
| **Side panel** (`src/sidepanel/`) | While open | React UI: Lore / Chat / Config views |

Communication: `chrome.runtime.sendMessage` for request/response,
long-lived ports for chat streaming (`chat-stream`, also acts as SW
keep-alive), `BroadcastChannel` for progress fan-out (imports, re-index,
sync). Multi-MB payloads (PDFs) never cross the message boundary — the
offscreen document fetches URLs itself (`OFFSCREEN_PARSE_PDF_URL`).
Offscreen calls go through `lib/offscreen-client.ts` (retry, failure
counting, forced recreation, health check) rather than raw `sendMessage`.

## Service worker layout

`service-worker.ts` is the router + the coupled cores (capture, chat
request building, research job lifecycle). Cohesive low-coupling units are
extracted:

- `background/llm-client.ts` — OpenAI-compatible provider: settings, chat,
  SSE streaming (token-coalesced), model listing.
- `background/library-handlers.ts` — library-wide search, `/recall`.
- `background/document-handlers.ts` — document CRUD.
- `background/project-handlers.ts` — project/chat CRUD.
- `background/deep-researcher.ts` — staged research pipeline + agents.

## Data flow (capture → answer)

```
page/PDF/YouTube ──content script / offscreen──▶ markdown
  ▶ quality gate (anti-bot, paywall, thin, table-soup rejected)
  ▶ frontmatter (Obsidian-compatible YAML)
  ▶ chunker (heading/paragraph-aware, stable citation anchors d{id}.s{n}.p{n})
  ▶ embeddings (384-dim, local all-MiniLM-L6-v2 in offscreen)
  ▶ IndexedDB (documents + chunks WITH vectors)

question ──▶ hybrid retrieval (Orama BM25 + vectors, in-memory per project,
             rehydrated from IDB after SW restarts — no re-embedding)
  ▶ cross-encoder rerank (ms-marco-MiniLM) + relevance gate + score cliff
  ▶ citation-anchored context → LLM (user's OpenAI-compatible endpoint)
  ▶ streamed reply; [anchor] citations resolve to chips → click opens the
    document at the cited passage (text-match highlighting in the
    frontmatter-stripped coordinate space)
```

## MV3 survival model

- **Keep-alive during research**: 20 s `getPlatformInfo()` heartbeat
  (known-bug-based; durable path is moving long work into the offscreen
  document — planned).
- **Crash-safe research**: job state in `chrome.storage.local`, scraped
  pages in a dedicated IndexedDB; auto-resume on worker start gated by an
  `active` flag, heartbeat freshness, job age, and a 3-attempt cap
  (see `docs/MV3-PERSISTENT-AGENT-STATE.md`).
- **Storage durability**: `unlimitedStorage` permission exempts the library
  from quota eviction.

## Design invariants

1. **Local-first** — content, chunks, vectors, models: all on-device. Only
   the user's configured LLM endpoint and research fetchers touch the network.
2. **Citations are anchors, not vibes** — every retrievable chunk carries a
   stable anchor; the model may only cite anchors present in context;
   unresolvable anchors are dropped by the renderer.
3. **The index only holds citable knowledge** — noise (nav, link farms,
   number-soup tables, YAML frontmatter) is filtered at chunk time; artifact
   documents (`research-sources` lists, `skill` files) are saved
   `enabled: false` with zero chunks so they can never surface in retrieval
   or citations.
4. **The user initiates every write** — capture, import, `/recall`, a
   research run, `/create-skill`: all explicit acts. A research run saves
   its sources as first-class documents (that's what makes citations
   permanently resolvable), but only because the user started that run;
   nothing enters the library from ambient browsing.
