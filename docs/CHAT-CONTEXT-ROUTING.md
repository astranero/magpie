# Chat Context Routing

How a chat turn decides **where the answer comes from** (the open page, the
workspace library, followed links, repo code, or the live web) and how the
session stays in sync across windows. Lives mostly in
`background/service-worker.ts` (`buildChatRequest` + the `chat-stream` port
handler), with pure, unit-tested logic in `lib/query-intent.ts` and
`lib/context-retrieval.ts`.

> ⚠️ This file documents **invariants that must not regress** — each was a
> user-reported bug this system was built to fix. Read the "Gotchas" before
> touching the routing order or the sync layer.

## The turn pipeline (`buildChatRequest`)

Order matters — the FIRST matching branch wins:

1. **Chit-chat** (`isChitchat`) → conversational reply, no retrieval. A greeting
   stays a greeting even with a page open.
2. **Assistant-meta** (`isAssistantMetaQuestion`) — "do you support kurdish?",
   "who are you?" → conversational capabilities reply, no page/retrieval/web.
   The matcher is DELIBERATELY narrow (language objects + anchored identity
   asks only): a false positive hijacks a real question ("do you support
   webhooks?" on a product page) into a canned blurb, so precision beats
   recall — a missed meta question just takes the normal route.
3. **Intent router** decides `usePage` (below). Everything after keys off it.
4. **Workspace citation** — only when `!usePage` AND `!isLocationDependent` AND
   `isConfidentMatch(chunks)`. Strict anti-hallucination prompt; sets
   `grounded=true`.
5. **Page branch** — `usePage`. Answer from the current page (+ selective
   enrichment below). No web search, no library docs.
6. **No-page deixis** — a page-deictic question ("what does this page say?")
   with NO page attached explains how to attach one instead of web-searching
   the phrase (which returned arbitrary pages as "Sources").
7. **Web / general** — live web fallback (`gatherWebSnippets`, localized) else
   general knowledge. General-knowledge turns get a deterministic
   "*No matching sources…*" disclosure emitted by the STREAM layer on the
   first real token (never before the provider call — an early emit persisted
   orphan disclosure-only bubbles when the provider failed instantly).

A **locale block** (approx. place + timezone) is prepended to *every* branch,
and a **language rule** (answer in the user's language) rides every branch's
prompt — `questionKeywords` is Unicode-aware so non-Latin questions still
produce routing signal.

## The intent router (`isQuestionAboutPage`)

`pageContext` is set **only when the user toggles 📄 ON** → an explicit "answer
about THIS page" signal. But it must not hijack unrelated questions ("is it cold
today?"). `usePage = pageContext && isQuestionAboutPage(q, page)`:

1. `isLocationDependent(q)` → **false** (weather/near-me is about the world).
2. `mentionsPageDeixis(q)` ("this project", "the docs") → **true**, instant.
3. `overlapsPage(q, page)` — a *meaningful* keyword shared with the page (common
   words excluded) → **true**, instant.
4. Otherwise one cheap `PAGE`/`OTHER` LLM classify. **Cached** per
   `url::question` (5-min TTL). Fails **open** to the page.

## Selective page enrichment (strategies)

When `usePage`, load ONLY the relevant files/links under shared caps
(`context-retrieval.ts`: `MAX_FILES=3`, `MAX_LINKS=2`, `MAX_SELECTED=4`,
`TOTAL_CTX_BUDGET=40k`, `FETCH_DEADLINE_MS=8s`). Strategy is user-toggleable
via `pageContextStrategy` (Config → Page context):

- **semantic** (default) — `selectSemantic`: explicit filename match → else
  rerank keyword-filtered paths; links: lexical (nav-synonym expanded) → else
  reranker picks the best link **by the question**, gated to non-meta asks and a
  0.5 confidence bar.
- **router** — one LLM JSON selection call (`parseRouterSelection`, validated),
  same budgeted fetch; falls back to semantic.
- **agentic** — `agenticGather`: bounded tool loop (`read_file`/`read_link`/
  `search_web`, ≤3 rounds) via `chatWithTools`. **Throws on round-0 no-tool-calls
  so the caller falls back to semantic** (a non-tool model would otherwise return
  zero context).

Extra behaviors, all in the page branch:

- **Tree inlining** only for structure questions (`isStructureQuestion`) — no
  227-path dump otherwise.
- **Repo dig** — an implementation question (`isImplementationQuestion`) on a
  non-repo page that *links* to its repo (`findRepoUrlInText`) follows that link
  and answers from code. The URL is page-supplied → its files are **data**; hosts
  are allow-listed (`parseRepoUrl`).
- **Forward-check** — if nothing on the page answered a concrete topical ask,
  search the **same host only** (`gatherWebSnippets({restrictToHost})`,
  exact/dot-boundary match) instead of dead-ending. Gated off for
  `isPageMetaQuestion` and when web fallback is disabled.
- **Enumeration** — `isEnumerationQuestion` ("what X are…", "list…", "other…")
  feeds the page in **reading order** (not semantic-nearest chunks), so the whole
  list is present (`selectPageMarkdown`).

## Location awareness

`place = userLocation setting || timezoneToPlace(araTimezone)`. The timezone is
captured **in the sidepanel** (a real document) and stored as `araTimezone` —
the MV3 service worker's own `Intl` can report `UTC`. The place is injected into
the prompt and appended to a web query **only** when `isLocationDependent`.

## Offscreen inference runs in a Worker

`offscreen/inference.worker.ts` holds the embedder + reranker. The offscreen
document only proxies `OFFSCREEN_GET_EMBEDDINGS` / `OFFSCREEN_RERANK` to it.
Reason: the offscreen doc shares a renderer with the sidepanel, and inline ONNX
inference froze the chat UI. `chrome.*` is unavailable in the Worker, so the wasm
base URL is passed on `init`. Calls are bounded (`WORKER_CALL_TIMEOUT_MS`).

## Cross-window sync (`sidepanel/App.tsx`)

The side panel is **per-tab**, so each window/tab is a separate React instance.

- **Active session** — synced as ONE `araActiveSession = {projectId, chatId}`
  pair via `chrome.storage.local` + `onChanged`. Never two independent keys (a
  chat id without its project leaked a stale chat into new sessions). Written
  only after `loadChats` reconciled the chat to the project. `lastSessionJsonRef`
  skips redundant echo writes.
- **Live answer mirroring** — chat streaming is a point-to-point port, so the
  background *also* broadcasts `CHAT_STATE {generating, prompt}` / `CHAT_DELTA` /
  `CHAT_RESET` via `chrome.runtime.sendMessage`. Non-initiating instances render
  them live; the initiator ignores its own echo via `streamingChatsRef`.
- **Mid-stream mount** — a panel that switches in while a chat is answering pulls
  the accumulated text with `GET_CHAT_STREAM` (`liveChatStreams` map) and keeps
  streaming (`resumeMirror`).
- **rAF caveat** — mirrored deltas render via a **direct setState**
  (`appendMirrorDelta`), NOT `pushDelta`/`requestAnimationFrame`. rAF is paused in
  a non-focused/hidden panel, which is why the mirror previously only appeared
  after the answer finished. A truly hidden panel still can't paint (browser
  won't) but catches up instantly on show.

## Gotchas (do not regress)

- **📄 ON = page wins**, but only when the router says the question is about the
  page. Don't blanket-force the page (breaks "is it cold today?") and don't let a
  keyword-matching library doc hijack it (`!usePage` gate on the citation branch).
- **Both web paths need location** — the primary web branch AND the
  refusal→web net (`grounded` refusals) localize the query and carry `place`.
- **Link-following precision** comes from lexical-first + `isPageMetaQuestion`
  (keeps "summarize this page" from dragging in tangential links), NOT from a high
  rerank bar. Links share the files' 0.5 bar.
- **Same-site host match** must be exact or dot-boundary — plain `endsWith`
  matches look-alikes (`notlearn.microsoft.com`).
- **Agentic must throw**, not return empty, when the provider can't tool-call.
- **Session sync is a pair**, never separate project/chat keys.
- **Mirrors don't use rAF.**
- **Assistant-meta stays narrow** — language/identity asks only. "do you
  support webhooks?" / "can you respond in JSON?" must keep routing to the
  page/workspace, and page deixis always wins over meta.
- **History fed to the model strips the `*Sources:*` footer**
  (`stripSourcesFooter`) — left in, the model imitates it and answers end with
  two Sources lines.
- **CLI route gets the SAME composed context** as the standard provider
  (`composeCliPrompt` over stdin via companion ≥1.1; `claude -p` derived from
  the user's template so configured flags survive). Untrusted page/source
  content NEVER goes into the shell command string — stdin only. CLI output is
  sanitized (`sanitizeCliOutput`) and error states (logged-out, usage dumps —
  length-gated) throw so the turn falls back to the standard provider instead
  of rendering "Not logged in" as an answer.
- **Don't pre-embed before `saveDocument`** — it already embeds every chunk
  (`embedTextsBatched`, db.ts); a wrapper embed doubles the work and its
  vectors are discarded.

## Config keys (`chrome.storage.local`)

`pageContextStrategy` (`semantic`|`router`|`agentic`), `userLocation`,
`araTimezone`, `araActiveSession`, `chatWebFallback`.

## Tests

`lib/__tests__/context-retrieval.test.ts`,
`lib/__tests__/query-intent.test.ts` cover the pure selection + intent helpers
(routing heuristics, nav synonyms, enumeration, location, host filter, budget
caps, router-JSON parse/fallback). The service-worker wiring + sync layer are
integration-level (not unit-tested).
