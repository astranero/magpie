<div align="center">

<img src="apps/extension/src/icons/icon128.png" width="88" alt="" />

# Magpie

**Your research collector.**

*A magpie gathers what glitters and keeps it somewhere safe. This one does it for
reading: capture the page, keep the source, and every answer comes back with a
thread you can pull.*

[![Build](https://img.shields.io/github/actions/workflow/status/astranero/magpie/verify.yml?style=flat-square&label=build&labelColor=392C23&color=406D53)](https://github.com/astranero/magpie/actions/workflows/verify.yml)
[![License](https://img.shields.io/badge/license-non--commercial-D15F2E?style=flat-square&labelColor=392C23)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/chrome-MV3-CD7087?style=flat-square&labelColor=392C23)](ARCHITECTURE.md)
[![Local first](https://img.shields.io/badge/data-stays%20local-406D53?style=flat-square&labelColor=392C23)](docs/SECURITY.md)

</div>

---

A Chrome extension that turns your browser into a personal research library.
Capture pages and PDFs, search everything you've collected, chat with your
sources, and run multi-agent deep research — every claim traced back to the
paragraph it came from.

```
   capture  ─→  index  ─→  search  ─→  answer
   page,        Orama +    semantic    grounded, with a
   PDF,         ONNX       + keyword   citation on every
   YouTube      embeddings  hybrid     load-bearing claim
```

Nothing leaves your machine except the model calls you configure. Embeddings,
reranking, and the whole library run locally.

## Contents

[Features](#features) · [Quick start](#quick-start) · [Commands](#commands) ·
[Architecture](#architecture) · [Documentation](#documentation) ·
[Contributing](#contributing) · [License](#license)

## Features

| | |
| :-- | :-- |
| **Collect** | Web pages, PDFs and YouTube transcripts into one library |
| **Find** | Hybrid search — semantic meaning *and* exact keywords |
| **Ask** | Answers grounded in what you actually saved |
| **Research** | Multi-stage agents: web, academic and news, cross-checked |
| **Trace** | Every citation is a link back to the source paragraph |
| **Sync** | Optional Google Drive backup of your workspaces |

## Quick start

**You'll need** Node.js 18+ (20 LTS recommended) and npm 9+.

```bash
git clone https://github.com/astranero/magpie.git
cd magpie
npm install            # npm workspaces monorepo — install from the root
npm run build:extension
```

The build is cross-platform (macOS, Linux, Windows PowerShell/cmd) and writes to
`apps/extension/dist`.

Then load it:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. **Load unpacked** → select `apps/extension/dist`
4. Click the Magpie icon to open the side panel

> [!TIP]
> **Installing with an AI agent?** Point it at
> [.opencode/skill/install-magpie/SKILL.md](.opencode/skill/install-magpie/SKILL.md) —
> a step-by-step guide it can follow to clone, build, and load Magpie.

> [!NOTE]
> **Windows:** if `node`/`npm` aren't on your `PATH`, install Node.js LTS
> (`winget install OpenJS.NodeJS.LTS`) and reopen your terminal. If your
> execution policy blocks `npm.ps1`, call `npm.cmd` directly.

## Commands

| Command | What it does |
| :--- | :--- |
| `/research <topic>` | Web search + cited report in ~30s |
| `/deepresearch <topic>` | Multi-stage: web + academic + news, cross-checked |
| `/academic <topic>` | Papers only (Semantic Scholar, arXiv, CrossRef, HuggingFace) |
| `/recall <topic>` | Search your captured library |
| `/page <question>` | Ask about the current browser tab |
| `/grill <topic>` | Stress-test a plan — one question at a time |
| `/teach <topic>` | Learn a topic across sessions, tracked in this workspace |
| `/create-skill <instruction>` | Turn findings into a reusable command |
| `/clear` | Reset chat |

## Architecture

A Chrome MV3 extension in three parts: a service worker that thinks, a side
panel you talk to, and an offscreen document that does the heavy lifting.

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

Built with TypeScript · React · Vite · ONNX Runtime · IndexedDB ·
Orama · Tailwind CSS.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown.

## Documentation

| | |
| :-- | :-- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component map |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust model, CSP, egress |
| [docs/STORAGE.md](docs/STORAGE.md) | IndexedDB schema |
| [docs/CAPTURE.md](docs/CAPTURE.md) | Capture paths |
| [docs/RESEARCH-PIPELINE.md](docs/RESEARCH-PIPELINE.md) | Agents & synthesis |
| [docs/CITATIONS.md](docs/CITATIONS.md) | Anchor grammar |
| [docs/MCP.md](docs/MCP.md) | MCP server config |
| [docs/TESTING.md](docs/TESTING.md) | Test suite |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

Non-Commercial Source-Available — see [LICENSE](LICENSE).

**Free for personal and educational use.** Commercial use requires explicit permission.

<div align="center">

<sub>Built in Helsinki by <a href="https://github.com/astranero">Kozheen Taher Esa</a></sub>

</div>
