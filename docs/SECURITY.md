# Security & Trust Model

Factual description of the extension's trust boundaries as implemented.
Open decisions (things this doc deliberately does not settle) are marked ⚖.

## Privilege map

| Context | Privileges | Attack surface |
|---|---|---|
| Service worker | All extension APIs, all host permissions | Messages from extension pages/content scripts only |
| Offscreen document | Fetch (any origin), DOM parsing, WASM models | Input = HTML/PDF bytes handed to parsers |
| Content script (`<all_urls>`) | Page DOM read | Responds ONLY to `chrome.runtime` messages (`SCRAPE_PAGE`); no `window.postMessage` listener, so the page cannot drive it |
| `inject.ts` (YouTube) | Page-world read of the YT player object | Read-only expression, returns transcript metadata |
| Side panel | Extension pages CSP | Renders LLM output as markdown (see below) |

CSP (`extension_pages`): `script-src 'self' 'wasm-unsafe-eval'` —
`wasm-unsafe-eval` exists solely for the ONNX runtime (transformers.js);
no remote code, no inline script. Web-accessible resources are limited to
`transformers/*.mjs|wasm` (model runtime assets).

## Data at rest

- **IndexedDB** (documents, chunks, embeddings, chat history): unencrypted,
  device-local, profile-scoped — standard for extensions.
- **`chrome.storage.local`**: provider API key (`customKey`), `s2ApiKey`,
  `searchApiKeys` (Tavily/Brave/Serper), MCP `authToken`s — stored in
  plaintext. This is the extension-platform norm (no OS keychain access from
  MV3), and any process that can read the Chrome profile already owns the
  browser session. ⚖ encrypting at rest buys little without a separate key
  but could be revisited.
- Local-folder sync mirrors documents as plaintext `.md` to a user-picked
  directory — explicit user action grants the handle.

## Network egress inventory

"Local-first" means content, chunks, vectors, and models stay on-device.
These endpoints ARE contacted:

| Endpoint | When | What leaves the device |
|---|---|---|
| User's LLM endpoint (`customUrl`) | Chat, research planning/synthesis, vision OCR, skill creation | Retrieved chunk text, chat history, page content |
| `r.jina.ai` (Jina Reader) | Research scraping (primary) and DDG-blocked fallback | URLs being scraped (third party sees your research trail) ⚖ |
| `html.duckduckgo.com`, `news.google.com/rss` | Keyless research discovery | Search queries / topics |
| `api.semanticscholar.org`, `api.crossref.org`, `huggingface.co` (papers + model weights), `arxiv.org` | Academic agent, model download | Queries, DOIs; nothing user-authored |
| Tavily/Brave/Serper | Only when the user adds a key | Search queries |
| User-registered MCP servers | Only when the user enables the server | The research topic (and bearer token, if configured) |
| Google APIs | Only after interactive OAuth | Synced documents (Drive) |

No telemetry, no first-party backend.

## Untrusted-input boundaries

1. **Scraped web content → LLM prompts.** Everything the research pipeline
   fetches (web pages, PDFs, MCP tool output) is untrusted text that ends up
   inside LLM context windows. A hostile page can attempt prompt injection
   against synthesis. Current mitigations: content passes the quality gate
   (a spam filter, NOT a security control), and the citation contract limits
   the blast radius of fabrication (the model may only cite `<c>` anchors
   present in context; unresolvable anchors are dropped by the renderer).
   There is no explicit injection hardening in research prompts. ⚖
2. **LLM output → side panel.** Rendered via react-markdown (no
   `dangerouslySetInnerHTML`); `urlTransform` restricts URLs to
   markdown-safe schemes plus `data:image/`. Citation chips only resolve
   against the local chunk store.
3. **MCP servers.** Registering + enabling a server is the permission grant:
   research will POST the topic to that URL and index what comes back as a
   source. No scheme/origin restriction is enforced on the URL. ⚖
4. **Imported files.** Local `.md`/PDF/images are parsed on-device
   (pdf.js with `isEvalSupported: false`; images inlined as data URLs).

## Permissions rationale

- `<all_urls>` host permission + content script: capture must work on any
  page the user is reading. Capture is user-initiated (toolbar/context menu).
- `unlimitedStorage`: exempts the library from quota eviction.
- `identity` is **optional** and only requested for Drive sync.

## ⚖ Open decisions (tracked, not settled here)

- MCP URL policy: allow any http(s) URL (status quo) vs https-or-localhost.
- Prompt-injection hardening for research synthesis (delimiting scraped
  content + explicit "ignore embedded instructions" contract).
- Jina Reader privacy trade-off: opt-out toggle vs status quo.
