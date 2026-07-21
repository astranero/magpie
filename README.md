# Magpie — AI Research Assistant

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Build Status](https://img.shields.io/badge/build-passing-brightgreen)

A Chrome extension that turns your browser into a personal research library. Capture pages and PDFs, search everything you've collected, chat with your sources, and run multi-agent deep research — all with source-grounded citations.

```
  ┌──────────────────────────────────────────────────────┐
  │  📄  Capture →  Index  →  🔍  Search  →  💬  Answer │
  │  Any page,    Orama+ONNX  Semantic+    With citations│
  │  PDF, YouTube  embeddings  keyword      [1][2][3]    │
  └──────────────────────────────────────────────────────┘
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

- **Capture & Index:** Save web pages, PDFs, and YouTube videos to your personal library.
- **Semantic Search:** Search your library using natural language.
- **Chat with Sources:** Ask questions and get answers grounded in your captured documents.
- **Multi-Agent Research:** Perform deep research tasks with autonomous agents.
- **Citation Tracking:** All answers are backed by citations to your sources.
- **Drive Sync:** Sync your research projects to Google Drive.

## Quick Start

### Prerequisites

- Node.js (v18 or later)
- npm (v9 or later)

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/astranero/magpie.git
    cd magpie
    ```

2.  Install dependencies and build the extension:
    ```bash
    cd apps/extension
    npm install
    npm run build
    ```

3.  Load the extension in Chrome:
    -   Open `chrome://extensions`.
    -   Enable "Developer mode" in the top right.
    -   Click "Load unpacked".
    -   Select the `apps/extension/dist` folder.

4.  Click the Magpie extension icon in the toolbar to open the side panel.

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

Magpie is built as a Chrome Extension (MV3) with a service worker, a side panel for the UI, and an offscreen document for heavy processing like parsing and embeddings.

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

For more details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Technologies

- **Core:** TypeScript, React, Vite
- **Extension:** Chrome Extensions MV3
- **AI/ML:** ONNX Runtime, Orama (hybrid search)
- **Styling:** Tailwind CSS
- **Storage:** IndexedDB

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Component map and architectural overview.
- [docs/SECURITY.md](docs/SECURITY.md) — Trust model, Content Security Policy (CSP), and data egress.
- [docs/STORAGE.md](docs/STORAGE.md) — IndexedDB schema and data management.
- [docs/CAPTURE.md](docs/CAPTURE.md) — Document capture pipelines.
- [docs/RESEARCH-PIPELINE.md](docs/RESEARCH-PIPELINE.md) — Research agents and synthesis process.
- [docs/CITATIONS.md](docs/CITATIONS.md) — Citation anchor grammar.
- [docs/MCP.md](docs/MCP.md) — Model Context Protocol (MCP) server configuration.
- [docs/TESTING.md](docs/TESTING.md) — Testing strategy and suite.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
