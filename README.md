# Magpie — Your Research Assistant

Chrome extension (Manifest V3): capture web pages, PDFs, YouTube transcripts and local
files into a **local-first knowledge base**, then chat with your research using source-grounded citations. Includes a multi-agent deep-research mode that gathers web, academic, and news sources, cross-references them, and writes a cited report.

Everything lives in your browser (IndexedDB + a local embedding model in an
offscreen document). The only network calls are to your configured LLM endpoint
and the research fetchers — the full egress inventory and trust model are in
[docs/SECURITY.md](docs/SECURITY.md).

## Install

```bash
cd apps/extension
npm install
npm run build
```

Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `apps/extension/dist`. Click the toolbar icon to open the side panel
(click again to close it).

## Configure (Config tab)

| Setting | Notes |
|---|---|
| Base URL | Any OpenAI-compatible API. Ollama: `http://localhost:11434/v1` · OpenRouter: `https://openrouter.ai/api/v1` |
| API Key | Empty for local Ollama |
| Model | Chat model (streamed) |
| Vision Model | For scanned PDFs / images. Blank = reuse chat model |
| Auto-add captures | ON: captures link to the active workspace. OFF: captures land in the Global Library only |
| Local save folder | Optional. Captured docs written as `.md` with Obsidian-compatible YAML frontmatter; two-way sync every 5 min |

Research settings (Config → Research): **depth tier** (Standard ~30 / Deep ~80 /
Exhaustive ~150 sources), **model context window** (synthesis packs evidence to
fit it), and an optional **Semantic Scholar API key** for higher academic rate
limits. Custom slash commands and MCP servers have their own Config sections.

## Capture

- **Capture button** — current tab. Handles article pages, PDFs (including
  extension-less URLs like `arxiv.org/pdf/…`, parsed locally with pdf.js), and
  YouTube watch pages (transcript via timedtext, falling back to the player's
  own transcript panel).
- **Right-click** — "Capture page to Library" / "Capture selection to Workspace".
- **Import** — local `.md` files/folders (relative images inlined), PDFs
  (scanned pages OCR'd by the vision model), images.

Every saved document carries YAML frontmatter (`title`, `type`, `source`,
`author`, `captured`, `created`, `word_count`, `tags` incl. `source/<domain>`)
so Obsidian and other tools can index it.

## Chat commands

| Command | Does |
|---|---|
| `/research <topic>` | Quick web research — posts an editable plan into the chat first: refine it by typing ("drop question 2"), then start |
| `/deepresearch <topic>` | Multi-agent: WEB + ACADEMIC (Semantic Scholar, HuggingFace) + NEWS (Google News RSS), balanced sources, confidence-tagged synthesis. Same in-chat plan step |
| `/analyze [focus]` | Overview of everything in the workspace: clusters, findings, gaps |
| `/create-skill [focus]` | Distill this workspace's research into a reusable custom command (+ a browsable skill file in Lore) |
| `/compare A vs B` · `/timeline <topic>` | Structured views over your sources |
| `/challenge` · `/connect` · `/extract` · `/brief` | Reasoning modes over your sources |
| `/page <q>` | Ask about the page you're viewing (nothing saved) |
| `/recall <topic>` | Pull relevant docs from your Global Lore into the active workspace |
| `/follow <url>` | Preview any link **inside the panel**, then capture it if it's a keeper. Clicking links in chat or documents does the same (Cmd/Ctrl-click for a browser tab) |
| `/clear` · `/help` | Clear chat · full list |

Define your own commands in Config → Custom Commands (trigger + prompt — they
run over your sources with citations like the built-ins). MCP servers exposed
over Streamable HTTP can be registered in Config → MCP Servers; deep research
calls their search-like tools as an extra source channel.

Every scraped page passes a quality gate (anti-bot pages, paywalls, login
walls, error pages, thin content are rejected). Blocked publisher pages with a
DOI (ACM, IEEE, Springer…) are recovered via Semantic Scholar metadata, and
academic papers carry a generated BibTeX entry — copy it with the Cite button
when viewing the document.

Research requests are **context-aware**: "best way to use these information"
gets rewritten into a standalone topic using your recent chat + workspace docs
(the interpretation is shown in the log and report).

Citations render as numbered chips — click one to open the source document with
the exact cited paragraph highlighted. Every research run also saves a
**Research Sources** document in Lore: the consolidated source list per agent
with quality tiers (★ high = authority domain / arXiv / DOI / ≥10 citations)
and citation counts. Chat stays usable while research runs — progress shows as
a live card with its own Stop button.

## Crash-safe deep research

Deep research checkpoints itself continuously (plan + every scraped page) to
persistent storage. If the service worker is killed or the whole browser goes
down mid-run, the job **auto-resumes from the checkpoint** the next time the
browser starts — already-fetched pages come from cache, only the remaining work
runs. Progress logs persist too: reopen the panel anytime to see where it is.
(An extension can't execute while the browser is closed — the run pauses and
continues, it doesn't fail.)

## Architecture

```
apps/extension/src/
  background/
    service-worker.ts   message router, capture, chat streaming (SSE over a
                        port), research job lifecycle + auto-resume, Drive sync
    deep-researcher.ts  multi-agent research: planning, WEB/ACADEMIC/NEWS
                        agents, source balancing, checkpointed scrape cache
  offscreen/            pdf.js parsing, HTML→markdown, local embedding +
                        reranker models
  content/              Readability+Turndown page scraper, YouTube transcripts
  sidepanel/            React UI (Sources / Chat / Config)
  lib/
    db.ts               IndexedDB: projects, chats, documents, chunks(+vectors)
    chunker.ts          heading-aware chunking with stable citation anchors
    citations.ts        anchor grammar + anti-hallucination system prompt
    vector-store.ts     in-memory Orama index, hybrid BM25+vector + rerank
    research-store.ts   crash-safe research job state + scraped-page cache
    frontmatter.ts      Obsidian-compatible YAML frontmatter
```

Retrieval: chunks are embedded locally (384-dim) at save time and stored with
their vectors; search is hybrid (BM25 + cosine) with typo tolerance and local
cross-encoder reranking. The in-memory index rebuilds itself from IndexedDB
after the MV3 worker restarts — no re-embedding needed.

## Dev

```bash
npm run build   # tsc + vite (background, sidepanel, content, inject)
```

Reload the extension in `chrome://extensions` after building.
