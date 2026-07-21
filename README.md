<div align="center">

# 🧠 Magpie

**Your AI Research Assistant — right in your browser sidebar**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)]()
[![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)]()
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)]()
[![Chrome MV3](https://img.shields.io/badge/Chrome_MV3-4285F4?style=flat-square&logo=google-chrome&logoColor=white)]()
[![Tests](https://img.shields.io/badge/Tests-454_passing-22c55e?style=flat-square)]()

Capture everything. Search anything. Cite everything.

</div>

---

## ✨ What It Does

Magpie is a Chrome extension (Manifest V3) that turns your browser into a personal research assistant:

| Feature | What you get |
|---------|-------------|
| **📄 Capture** | Save any web page, PDF, YouTube transcript, or local file into a searchable library |
| **🔍 Global Search** | Semantic + keyword search across everything you've collected |
| **💬 Chat with Sources** | Ask questions, get answers grounded in your captured sources with clickable citations |
| **⚡ Quick Research** | `/research <topic>` — web search + cited report in under a minute |
| **🧪 Deep Research** | `/deepresearch <topic>` — multi-agent pipeline: web + papers + news, cross-referenced |
| **🎓 Academic Mode** | `/academic <topic>` — papers-only (Semantic Scholar, CrossRef, arXiv, HuggingFace) |
| **🤖 Agentic Skills** | Create custom `/command` skills from your research findings |

---

## 🚀 Quick Start

```bash
# Clone and build
git clone https://github.com/astranero/magpie.git
cd magpie/apps/extension
npm install
npm run build
```

Then:
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select `apps/extension/dist`
4. Click the Magpie toolbar icon to open the side panel

---

## ⚙️ Configuration

| Setting | What it does |
|---------|-------------|
| **Base URL** | Any OpenAI-compatible API. `http://localhost:11434/v1` (Ollama) · `https://openrouter.ai/api/v1` |
| **Model** | Chat model for answers |
| **Vision Model** | OCR for scanned PDFs/images. Blank = reuse chat model |
| **Research Depth** | Standard (~30 sources) · Deep (~80) · Exhaustive (~150) |
| **API Keys** | Tavily/Brave/Serper for web · S2 key for academic rate limits |

> All data stays local (IndexedDB + browser embeddings). The only network calls are to your LLM endpoint and research fetchers. See [docs/SECURITY.md](docs/SECURITY.md) for the full egress inventory.

---

## 🏗️ Architecture

```
┌────── Service Worker ──────┐     ┌────── Side Panel ──────┐
│  Chat stream · Research ·   │     │  ChatView · Settings   │
│  Capture · Auth · Drive     │────▶│  LoreView · Document   │
└──────────┬──────────────────┘     └────────────────────────┘
           │
┌──────────▼──────────────────┐     ┌────── Offscreen ───────┐
│       IndexedDB + Orama     │◀───▶│  Embeddings · Reranker │
│  (documents · chunks ·      │     │  PDF parser · HTML     │
│   chats · history)          │     │  inference worker      │
└─────────────────────────────┘     └────────────────────────┘
```

Deep dive: [ARCHITECTURE.md](ARCHITECTURE.md) · [STORAGE.md](docs/STORAGE.md) · [RESEARCH-PIPELINE.md](docs/RESEARCH-PIPELINE.md)

---

## 📚 Documentation

| Doc | What it covers |
|-----|---------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component map: SW + offscreen + sidepanel + content script |
| [CAPTURE.md](docs/CAPTURE.md) | Web/PDF/YouTube/image capture paths |
| [CITATIONS.md](docs/CITATIONS.md) | Anchor grammar, resolution, highlight mapping |
| [MCP.md](docs/MCP.md) | MCP server config, tool discovery |
| [RESEARCH-PIPELINE.md](docs/RESEARCH-PIPELINE.md) | Agents, planning, synthesis, checkpointing |
| [SECURITY.md](docs/SECURITY.md) | CSP, trust model, egress inventory |
| [STORAGE.md](docs/STORAGE.md) | IndexedDB schema, Orama rehydration |
| [TESTING.md](docs/TESTING.md) | Running tests, coverage |

---

## 🧪 Test Suite

```bash
cd apps/extension
npm test          # 454 tests, 45 test files
npm run build     # tsc + Vite × 3 configs
```

---

## 📄 License

MIT
