# Magpie — Architecture

> Chrome MV3 extension: local-first research knowledge base with
> citation-grounded chat and multi-agent staged deep research.
> Component detail lives in `docs/` (STORAGE, CAPTURE, RESEARCH-PIPELINE,
> CITATIONS, CHAT-CONTEXT-ROUTING, MCP, SKILLS, SECURITY, TESTING).

## Execution contexts

MV3 forbids persistent background pages, so the extension is partitioned by
lifetime and capability:

| Context | Lifetime | Role |
|---|---|---|
| **Service worker** (`src/background/`) | Ephemeral (~30 s idle kill) | Message router, capture orchestration, chat/research lifecycle, checkpointing |
| **Offscreen document** (`src/offscreen/`) | Unbounded (`DOM_PARSER` reason) | Heavy compute: pdf.js parsing, HTML→markdown (Readability), embedding + reranker models (transformers.js) |
| **Content script** (`src/content/`) | Bound to tab | DOM scraping (Readability + Turndown), YouTube transcripts |
| **Side panel** (`src/sidepanel/`) | While open | React UI: Lore / Chat / Config views |
| **Companion server** (`companion-mcp.js`, *optional*) | User-run Node process | Local HTTP MCP bridge on `localhost:3920` that runs CLI LLMs / shell tools (`execute_command`) for the CLI provider route — only present if the user installs and registers it; gated by a shared `MAGPIE_COMPANION_TOKEN` |

Communication: `chrome.runtime.sendMessage` for request/response,
long-lived ports for chat streaming (`chat-stream`, also acts as SW
keep-alive), `BroadcastChannel` for progress fan-out (imports, re-index,
sync). Multi-MB payloads (PDFs) never cross the message boundary — the
offscreen document fetches URLs itself (`OFFSCREEN_PARSE_PDF_URL`).
Offscreen calls go through `lib/offscreen-client.ts` (retry, failure
counting, forced recreation on repeated failures, health check) rather than
raw `sendMessage`.

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
  ▶ embeddings (384-dim, multilingual-e5-small in offscreen)
  ▶ IndexedDB (documents + chunks WITH vectors)

question ──▶ hybrid retrieval (Orama BM25 + vectors, in-memory per project,
             rehydrated from IDB after SW restarts — no re-embedding)
  ▶ cross-encoder rerank (bge-reranker-v2-m3) + relevance gate + score cliff
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
  `active` flag, job age, and a 12-attempt cap
  (see `docs/MV3-PERSISTENT-AGENT-STATE.md`).
- **Storage durability**: `unlimitedStorage` permission exempts the library
  from quota eviction.

## Design invariants

1. **Local-first** — content, chunks, vectors, models: all on-device. Only
   the user's configured LLM endpoint and research fetchers touch the network
   (plus the optional local companion server on `localhost:3920`, if the user
   runs one — see the trust-boundary note in `docs/SECURITY.md`).
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
5. **📄 ON means the page wins — but only when the question is about it.** The
   intent router, selective page enrichment, location awareness, and
   cross-window live-answer sync each have subtle invariants that were bug
   fixes; see `docs/CHAT-CONTEXT-ROUTING.md` before editing chat routing or the
   sidepanel sync layer.
6. **Authentication** — GitHub Copilot SSO auth is supported as an alternative
   provider path (token exchange via `lib/copilot-auth.ts`); treat it as a
   first-class LLM endpoint alongside direct OpenAI-compatible keys. The GitHub
   host is configurable (`githubBaseUrl`), so the same device-code flow works
   against a GitHub Enterprise Server instance (`{host}/api/v3`), with the
   Copilot API URL overridable (`copilotApiUrl`).
