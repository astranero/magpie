
# Magpie — AI Research Assistant

A Chrome extension that turns your browser into a personal research library. Capture pages and PDFs, search everything you've collected, chat with your sources, and run multi-agent deep research — all with source-grounded citations.

```
  ┌──────────────────────────────────────────────────────┐
  │  📄  Capture →  Index  →  🔍  Search  →  💬  Answer │
  │  Any page,    Orama+ONNX  Semantic+    With citations│
  │  PDF, YouTube  embeddings  keyword      [1][2][3]    │
  └──────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
cd apps/extension
npm install
npm run build
```

Load the `apps/extension/dist` folder as an unpacked extension in `chrome://extensions`. Click the toolbar icon to open the side panel.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/research <topic>` | Web search + cited report in ~30s |
| `/deepresearch <topic>` | Multi-stage: web + academic + news, cross-checked |
| `/academic <topic>` | Papers only (Semantic Scholar, arXiv, CrossRef) |
| `/recall <topic>` | Search your captured library |
| `/page <question>` | Ask about the current browser tab |
| `/clear` | Reset chat |
| `/create-skill <instruction>` | Turn findings into a reusable command |

---

## Architecture

```
Service Worker              Side Panel              Offscreen
┌──────────────────┐     ┌──────────────────┐    ┌──────────────────┐
│ Chat streaming   │     │ ChatView         │    │ PDF parser       │
│ Research agents  │     │ Settings         │    │ HTML parser      │
│ Capture pipeline │────▶│ LoreView         │    │ Embeddings (ONNX)│
│ Auth (Copilot/   │     │ DocumentView     │    │ Reranker (ONNX)  │
│   Google Drive)  │     │ Field log        │    │ Inference worker │
└────────┬─────────┘     └──────────────────┘    └──────────────────┘
         │                                              │
         └────────────── IndexedDB ◄─────────────────────┘
                        documents · chunks · chats · history
                        Orama vector index (in-memory)
```

---

## Tech

TypeScript · React · Chrome Extensions MV3 · Vite · ONNX Runtime
IndexedDB · Orama (hybrid search) · Tailwind CSS · KaTeX

---

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — component map
- [docs/SECURITY.md](docs/SECURITY.md) — trust model, CSP, egress
- [docs/STORAGE.md](docs/STORAGE.md) — IndexedDB schema
- [docs/CAPTURE.md](docs/CAPTURE.md) — capture paths
- [docs/RESEARCH-PIPELINE.md](docs/RESEARCH-PIPELINE.md) — agents & synthesis
- [docs/CITATIONS.md](docs/CITATIONS.md) — anchor grammar
- [docs/MCP.md](docs/MCP.md) — MCP server config
- [docs/TESTING.md](docs/TESTING.md) — test suite

---

## License

MIT
