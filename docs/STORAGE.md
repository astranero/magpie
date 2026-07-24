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
| `docImages` | `${docId}/${imgId}`, index on `docId` | Extracted PDF figures / inlined import images (`blob`, `width`, `height`) |

Documents live once, globally ("Global Lore"); projects reference them.
Deleting a doc cascades to its chunks and extracted images (`docId` index)
and resets the library search index. URL is the dedup key: saving a doc
whose `url` already exists returns the existing id (via the `url` index)
instead of re-embedding.

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
`mcpServers`, `customSkills`, `autoLinkCaptures`, `includePageContext`,
`driveFolderName`, `syncResearchSources`, and the crash-safe
**research job checkpoint** (`magpie-research-job`: plan, phase,
logs, `active`, `lastHeartbeatAt`, `resumeAttempts`).

## Auxiliary IndexedDB

`MagpieResearchCacheDB.pages` (`lib/research-store.ts`): scraped pages of the
current research run keyed by URL — resume serves already-fetched pages from
here instead of the network. Cleared when a new job starts (so a fresh topic
never inherits a prior run's cached pages); a resumed run keeps the cache.

## Workspace Sync (Obsidian & Google Drive)

Magpie provides two main synchronization mechanisms for matching your local research library with external tools like Obsidian:

### 1. Google Drive Sync (Remote)
* **Auth & Scopes:** Uses Google OAuth2 (interactive sign-in). The `drive.file` scope means Magpie can only view and edit files/folders it created itself; `userinfo.email` + `userinfo.profile` are also granted, used only to display the connected account. See `docs/SECURITY.md` for the full egress inventory.
* **Obsidian Formatting:** Syncs research documents as `.md` files with Obsidian-compatible YAML frontmatter to a configured sync folder (`driveFolderName`, default: `Magpie`).
* **Automatic Background Sync:** Runs silently in the background:
  * When capturing a web page (`captureTab`).
  * When importing local files (Markdown, PDF, Images).
  * When a `/deepresearch` or `/academic` loop finishes.
  * Periodically every 5 minutes via the `sync-workspace` alarm.
* **Sync Filtering:** By default, raw crawled research sources (which clutter Obsidian vaults) are excluded from sync. Turning on **"Sync raw research sources"** (`syncResearchSources`) in the Config tab forces all crawled pages to sync.
* **Force Resync:** Clears the `syncedToDrive` flag and `driveFileId` on all documents, enabling a complete re-upload of your library to Google Drive (e.g. if the folder name is changed).

### 2. Local Folder Sync (Desktop)
* Uses the browser File System Access API (requiring a user gesture to grant permission).
* Mirrors documents as `.md` files to a selected local directory.
* Periodic two-way sync checks run every 5 minutes, coordinated via BroadcastChannel.
