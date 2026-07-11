# Vault — Architecture & Philosophy Reference

## The Context Layer Model

This project implements the **Context Layer Model** as described in the solopreneur enterprise architecture:

> "The company becomes the context layer. This shared brain is the company now. Humans and agents plug into it."

### Core Principles Applied

1. **Markdown as Universal Language** — All knowledge is stored as plain-text markdown files, universally readable and machine-parseable. The local vault serves as a persistent, machine-readable operating system for knowledge.

2. **Local-First Architecture** — All processing happens on the user's hardware. No cloud dependency for core functionality. The browser extension serves as the Context Layer interface.

3. **The Golden Rule: Agents Read, Humans Write** — The vault serves as the unpolluted source of truth. AI agents retrieve, analyze, and generate answers based on the vault, but the human decides what enters the knowledge base.

4. **Learning Velocity** — The competitive advantage comes from how fast the user can capture, structure, and query knowledge. Vault accelerates this cycle by:
   - One-click web page capture → markdown
   - PDF/image OCR → searchable text
   - Semantic chunking → instant retrieval
   - Source-grounded citations → verifiable answers

### Architecture Mapping

| Context Layer Concept | Vault Implementation |
|---|---|
| Shared Brain | IndexedDB document store + vector embeddings |
| Markdown Vault | Captured pages stored as `.md` with frontmatter |
| CLI Bridge | Chrome Extension Service Worker API |
| Context Loading | Semantic search → relevant chunks → LLM context |
| Preloaded Context | System prompts + citation anchors |
| Agent Execution | Deep Research (autonomous web search + synthesis) |

### Quality-First Research

Deep Research prioritizes high-quality sources:
- Academic papers (arxiv, nature, ieee, acm)
- Official documentation and technical blogs
- Expert analysis from reputable publications
- Primary sources and government data

Low-quality content farms, social media, and forums are actively filtered.

### API Economics

The extension supports multiple LLM providers with configurable routing:
- **Ollama** (local, free) for routine tasks
- **Gemini/OpenAI** (API) for complex reasoning
- Source-grounded citations prevent hallucination, reducing retry costs
