# Storage

## IndexedDB (main database — `lib/db.ts`)

Object stores:

| Store | Key | Holds |
|---|---|---|
| `projects` | `id` | Workspaces; `documentIds[]` links docs (many-to-many) |
| `chats` | `id` | Chat metadata per project |
| `chatHistory` | `id` | Messages (role, text, timestamp) |
| `documents` | `id` | Full markdown (`content`, incl. frontmatter), title, url, `capturedAt`, `wordCount`, `enabled` (false = excluded from retrieval), optional `bibtex` |
| `chunks` | `id`, index on `docId` | Chunk text, `anchorId`, heading/sectionPath, char offsets, **optional `embedding` (384-dim)** |
| `settings` | `key` | Misc key/value |

Documents live once, globally ("Global Lore"); projects reference them.
Deleting a doc cascades to its chunks (`docId` index) and resets the
library search index. URL is the dedup key: saving a doc whose `url`
already exists returns the existing id (via the `url` index) instead of
re-embedding.

Two artifact doc types are saved with `enabled: false` and **zero chunks**
so they are browsable but can never enter retrieval or citations:
`research-sources` (the consolidated source list of a research run) and
`skill` (the persisted copy of a /create-skill command).

**Vectors are data**: embeddings are computed once at save time (offscreen
model) and persisted on the chunk. Worker restarts rehydrate the in-memory
search index from stored chunks with **no re-embedding**.

`replaceChunksForDoc(docId, chunks)` swaps a document's chunk set atomically
(used by Re-index: re-chunk with the current pipeline + backfill embeddings).

## In-memory search indexes (`lib/vector-store.ts`)

Orama v3 instances keyed by session:
- one per **project** (that project's docs + ephemeral research chunks),
- one `__library__` session covering **every** document (library search,
  `/recall`).

Schema includes `embedding: vector[384]`; chunks lacking a valid vector get
a zero vector (BM25-only for them). `resetSessionIndex(projectId)` evicts
after research; `resetLibraryIndex()` on deletions; `resetAllSessionIndexes()`
after Re-index.

## chrome.storage.local

Config + small state: provider settings (`customUrl/customKey/customModel/
visionModel`), `researchDepth`, `sourceQuality`, `academicDepth`,
`contextTokens`, `s2ApiKey`, `searchApiKeys` (Tavily/Brave/Serper),
`mcpServers`, `customSkills`, `autoLinkCaptures`, `includePageContext`, and
the crash-safe **research job checkpoint** (`ara-research-job`: plan, phase,
logs, `active`, `lastHeartbeatAt`, `resumeAttempts`).

## Auxiliary IndexedDB

`ResearchJobCacheDB.pages` (`lib/research-store.ts`): scraped pages of the
current research run keyed by URL — resume serves already-fetched pages from
here instead of the network. Cleared when a job starts/finishes.

## Durability

`unlimitedStorage` permission exempts extension IndexedDB from quota
eviction. Local-folder two-way sync (File System Access API, 5-min alarm)
mirrors documents as `.md` files with YAML frontmatter for Obsidian.
