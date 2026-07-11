# Implementation Plan: /recall, Link-Following Stages, Large-PDF Parsing

Three independent features; tasks within each are sequential, the three
tracks are parallelizable across sessions.

## Overview

1. **/recall** — pull relevant Global Lore documents into the active
   workspace by asking in chat, ranked by metadata + content.
2. **Link-following research stages** — let deep-research stages chase
   references found *inside* gathered sources, alongside gap queries.
3. **Large PDFs** — multi-MB PDFs currently fail; root causes are the
   base64-over-`sendMessage` transfer (~64 MB message cap, 4/3 inflation,
   giant-string OOM in the worker) and fixed 30 s fetch timeouts — not pdf.js.

## Architecture Decisions

- **/recall reuses the `__library__` index** (built for library search).
  Metadata speed comes from a doc-level *metadata mini-index*: title + tags +
  type parsed once from frontmatter — searched lexically first (fast,
  no embedding call), then fused with chunk-level hybrid hits via RRF.
  No new storage; parsed lazily and cached in worker memory.
- **Linking is explicit and reversible**: /recall links docs to the current
  workspace (`linkDocumentToProject`) and reports what it pulled; unlink
  stays one click in Lore view. No silent auto-linking during normal chat —
  retrieval noise would silently grow the workspace.
- **Stages: queries remain primary, links become a secondary channel.**
  Gap queries explore breadth (new angles the sources don't mention);
  link-following exploits depth (provenance chains). Following *all* links is
  crawling — noise. Followed links are restricted to high-precision classes:
  DOI / arXiv IDs found in source text (always safe, zero LLM cost) plus
  markdown links whose anchor text is relevance-scored against the topic.
- **Large PDFs: move bytes out of `sendMessage`.** The offscreen document
  can `fetch` URLs itself; for local files, hand off via a temp IndexedDB
  record. Message payloads then carry only ids/URLs. Results stream back
  page-batch-wise over a port instead of one giant response.

## Task List

### Track R — /recall (chat-driven lore loading) ✅ DONE

#### R1: Metadata mini-index in the worker
**Description:** `lib/doc-meta-index.ts`: builds `{docId, title, tags[],
type, capturedAt}` for all docs by running `splitFrontmatter` +
`parseFrontmatterFields` over `doc.content` heads (first 2 KB is enough).
Cached in worker memory; invalidated with `resetLibraryIndex()` calls.
`scoreDocsByMetadata(query) → ranked docIds` — token overlap on title/tags,
recency tiebreak. Pure where possible.
**Acceptance criteria:**
- [ ] Tag query ("arxiv", "deep-research") ranks tagged docs first
- [ ] Runs <50 ms on 500 docs (no embeddings involved)
- [ ] Unit tests for scoring incl. no-match → empty
**Verification:** `npm test`; build clean.
**Files:** `src/lib/doc-meta-index.ts`, test file. **Scope:** S

#### R2: RECALL_DOCS worker handler
**Description:** `{query, projectId}` → RRF-fuse `scoreDocsByMetadata`
ranks with `searchLibrary` chunk hits (k=60) → top 5 docs **not already
linked** to the project → `linkDocumentToProject` each → return
`{linked: [{id,title,snippet}], considered}`.
**Acceptance criteria:**
- [ ] Already-linked docs never re-linked or reported
- [ ] Zero matches → `{linked: []}` (no error)
**Verification:** manual with a populated library. **Dependencies:** R1.
**Files:** `service-worker.ts`. **Scope:** S

#### R3: `/recall <topic>` chat command
**Description:** Registry entry (builtin). App intercepts, calls RECALL_DOCS,
posts a system message: "Pulled N documents into this workspace: • Title …"
(or "Nothing relevant found in your Global Lore"), refreshes doc list, and
notes chat retrieval now includes them. `/help` + palette update come free
from the registry.
**Acceptance criteria:**
- [ ] `/recall transformers` links relevant global docs and the next chat
      question can cite them
- [ ] Message lists titles; Lore view shows them linked
**Verification:** manual E2E. **Dependencies:** R2.
**Files:** `lib/commands.ts`, `App.tsx`. **Scope:** S

### Checkpoint R — build + tests green; manual: recall → ask → citation from recalled doc. 

### Track L — link-following stages ✅ DONE

#### L1: Reference harvester
**Description:** `lib/reference-harvest.ts`:
`harvestReferences(chunks, topic) → {url, kind: 'doi'|'arxiv'|'web', anchorText?}[]`.
Regex-extract arXiv IDs and DOIs from chunk text (always kept), plus
markdown links (kept only for later scoring). Dedup vs already-scraped URLs
(job page cache) and `isJunkUrl`.
**Acceptance criteria:**
- [ ] Extracts `arxiv.org/abs/…`, bare `2401.12345` in citation context, DOIs
- [ ] Junk/duplicate URLs excluded; unit tested
**Files:** `src/lib/reference-harvest.ts`, test. **Scope:** S

#### L2: Anchor-text relevance filter for web links
**Description:** Score `anchorText` of harvested web links against the topic
with the existing offscreen reranker (one batch call); keep score > gate.
DOI/arXiv skip scoring (inherently citable).
**Acceptance criteria:**
- [ ] Nav-style links ("Home", "Pricing") dropped; on-topic titles kept
**Dependencies:** L1. **Files:** `reference-harvest.ts` (+ worker call path).
**Scope:** S

#### L3: Wire into stage loop
**Description:** In `runDeeperResearch`'s inter-stage analysis: after
`analyzeGaps`, harvest references from the evidence chunks; next stage
scrapes `[...gapQueryResults, ...references]` with references capped at
~⅓ of the stage budget (`urlsPerQuery`). Log:
`[STAGE n] Following M references from sources (K arXiv/DOI, J web)`.
arXiv/DOI references route through the academic indexing path (full-text +
BibTeX), not plain scrape.
**Acceptance criteria:**
- [ ] Stage 2+ shows followed references in the log and the source mix
- [ ] Reference count never starves gap-query slots
**Dependencies:** L1, L2. **Files:** `deep-researcher.ts`. **Scope:** M

### Checkpoint L — deep run on a paper-heavy topic pulls at least one
reference-chased source; report cites it.

### Track P — large-PDF parsing ✅ P1+P2 DONE (P3 deferred)

#### P1: Diagnose + instrument (fail loudly first)
**Description:** Reproduce with a >25 MB PDF. Add explicit failure reasons:
catch `sendMessage` serialization errors, report PDF byte size + page count
in the error toast/log instead of generic "could not parse".
**Acceptance criteria:**
- [ ] Oversized PDF failure names the real cause and the size
**Files:** `pdf-parser.ts`, capture paths in `service-worker.ts`. **Scope:** S

#### P2: URL handoff — offscreen fetches the PDF itself
**Description:** New `OFFSCREEN_PARSE_PDF_URL {url}`: offscreen fetches
(no 30 s cap — size-scaled timeout, progress log) and parses; worker paths
(`capturePdfUrl`, page-context PDF, arXiv full-text) pass the URL instead of
base64 when the source is a URL. Base64 path remains for small buffers.
**Acceptance criteria:**
- [ ] 50 MB arXiv PDF captures successfully
- [ ] Message payloads no longer carry PDF bytes for URL sources
**Dependencies:** P1. **Files:** `offscreen.ts`, `pdf-parser.ts`,
`service-worker.ts`, `deep-researcher.ts`. **Scope:** M

#### P3: Local-file handoff via temp IndexedDB + streamed results
**Description:** Sidepanel PDF import writes `File` bytes to a temp IDB
store; offscreen reads by id and deletes after. Parse results return in
page batches over a `chrome.runtime.connect` port (existing import-progress
UX), with OCR image pages capped per batch to bound memory.
**Acceptance criteria:**
- [ ] 100 MB local PDF imports without OOM; progress visible per batch
- [ ] Temp record removed after parse (success and failure)
**Dependencies:** P2. **Files:** `offscreen.ts`, `pdf-parser.ts`, `App.tsx`
import path. **Scope:** M

### Checkpoint P — capture arXiv PDF >25 MB + import local >50 MB PDF; both
parse, chunk, and answer questions.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Parallel agent session edits same files | High | Track-per-commit; re-read before edit; tick MASTER_PLAN + this doc |
| /recall pulls plausible-but-wrong docs | Med | Explicit system message listing links; one-click unlink; no silent linking |
| Link-following drifts off-topic | Med | DOI/arXiv only by default for depth; web links gated by anchor-text rerank + ⅓ budget cap |
| Offscreen fetch lacks worker's DNR header rules | Low | PDFs are public URLs; fall back to worker fetch + base64 for small files |
| Giant PDFs still OOM pdf.js itself | Med | Page-batch parsing (P3); hard page cap with warning (e.g. 800 pages) |

## Open Questions

1. /recall: also *unlink* on request ("/recall drop <topic>")? (Default: no,
   Lore view handles it.)
2. Link-following in **quick** mode too, or deep-only? (Plan: deep-only.)
