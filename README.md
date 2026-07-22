# Magpie — AI Research Assistant

![License](https://img.shields.io/badge/License-Non--Commercial-red.svg)
[![Verify Build and Tests](https://github.com/astranero/magpie/actions/workflows/verify.yml/badge.svg)](https://github.com/astranero/magpie/actions/workflows/verify.yml)

A Chrome extension that turns your browser into a personal research library. Capture pages and PDFs, search everything you've collected, chat with your sources, and run multi-agent deep research — all with source-grounded citations.

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │   📄 Capture     Index          🔍 Search      💬 Answer            │
  │   Any page, ──▶  Orama+ONNX ──▶  Semantic+ ──▶ With citations       │
  │   PDF, YouTube   embeddings     keyword         [1][2][3]            │
  └──────────────────────────────────────────────────────────────────────┘
```

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Architecture](#architecture)
- [Technologies](#technologies)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Capture & Index:** Save web pages, PDFs, and YouTube videos to your personal library
- **Semantic Search:** Search your library using natural language
- **Chat with Sources:** Ask questions and get answers grounded in your captured documents
- **Multi-Agent Research:** Perform deep research tasks with autonomous agents
- **Citation Tracking:** All answers are backed by citations to your sources
- **Drive Sync:** Sync your research projects to Google Drive

## Quick Start

### Prerequisites

- Node.js (v18 or later)
- npm (v9 or later)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/astranero/magpie.git
   cd magpie
   ```

2. Install dependencies and build:
   ```bash
   cd apps/extension
   npm install
   npm run build
   ```

3. Load the extension in Chrome:
   - Open `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `apps/extension/dist` folder

4. Click the Magpie icon in the toolbar to open the side panel

## Commands

| Command | What it does |
| :--- | :--- |
| `/research <topic>` | Web search + cited report in ~30s |
| `/deepresearch <topic>` | Multi-stage: web + academic + news, cross-checked |
| `/academic <topic>` | Papers only (Semantic Scholar, arXiv, CrossRef) |
| `/recall <topic>` | Search your captured library |
| `/page <question>` | Ask about the current browser tab |
| `/clear` | Reset chat |
| `/create-skill <instruction>` | Turn findings into a reusable command |

## Architecture

Magpie is a Chrome Extension (MV3) with a service worker, side panel UI, and offscreen document for heavy processing.

```
Service Worker              Side Panel              Offscreen
┌──────────────────┐     ┌──────────────────┐    ┌──────────────────┐
│ Chat streaming   │     │ ChatView         │    │ PDF parser       │
│ Research agents  │     │ Settings         │    │ HTML parser      │
│ Capture pipeline │────▶│ LoreView         │    │ Embeddings (ONNX)│
│ Auth (Copilot/   │     │ DocumentView     │    │ Reranker (ONNX)  │
│   Google Drive)  │     │ Field log        │    │ Inference worker │
└────────┬─────────┘     └──────────────────┘    └──────────────────┘
         │                                               │
         └────────────── IndexedDB ◄─────────────────────┘
                        documents · chunks · chats · history
                        Orama vector index (in-memory)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown.

## Technologies

TypeScript · React · Chrome Extensions MV3 · Vite · ONNX Runtime · IndexedDB · Orama (hybrid search) · Tailwind CSS

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Component map
- [docs/SECURITY.md](docs/SECURITY.md) — Trust model, CSP, egress
- [docs/STORAGE.md](docs/STORAGE.md) — IndexedDB schema
- [docs/CAPTURE.md](docs/CAPTURE.md) — Capture paths
- [docs/RESEARCH-PIPELINE.md](docs/RESEARCH-PIPELINE.md) — Agents & synthesis
- [docs/CITATIONS.md](docs/CITATIONS.md) — Anchor grammar
- [docs/MCP.md](docs/MCP.md) — MCP server config
- [docs/TESTING.md](docs/TESTING.md) — Test suite

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

Non-Commercial Source-Available. See [LICENSE](LICENSE).

> **This code is free for personal and educational use.** Commercial use requires explicit permission.
