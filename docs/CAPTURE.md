# Capture

All ingestion paths converge on: markdown → frontmatter → chunk → embed →
save, with an added quality gate for scraped-URL sources (research,
`/follow`). Nothing enters the library implicitly.

## Paths

| Source | Route |
|---|---|
| **Web page** | Content script: Readability + Turndown → markdown, then the two salvage passes below. Fallback: inject `content.js` then retry; if the page still can't be scraped and isn't a PDF, the capture fails |
| **YouTube watch page** | Content script: timedtext API; empty/PO-token response falls back to scraping the player's own transcript panel |
| **PDF by URL** (incl. extension-less like `arxiv.org/pdf/…` — detected via HEAD content-type) | Background fetch first; if it yields no text and the PDF is open in a tab, the content script re-fetches it from inside the page so it carries the user's session (see *Gated PDFs*). Then `OFFSCREEN_PARSE_PDF_URL`: the offscreen document fetches (size-scaled timeout: 30 s + 3 s/MB, cap 5 min) and parses with pdf.js — bytes never cross `sendMessage` (~64 MB cap). Column-aware line building fixes two-column papers; citation brackets re-joined; scanned pages (no extractable text) get a placeholder marker — canvas/vision-model OCR rendering is currently disabled; 800-page cap |
| **Local `.md` files/folder** | File System Access picker; relative images inlined as data URLs (`lib/import-helpers.ts`); existing frontmatter preserved |
| **Local PDF/images** | Base64 path (guarded: >48 MB errors with size instead of OOM), async with BroadcastChannel progress; images described by the vision model |
| **Right-click** | "Capture page to Library" / capture selection |
| **Link follow** | Clicking an external link in chat or a document forwards the **current tab** there (the page lands beside the panel, ready for the page-context toggle); Cmd/Ctrl-click opens a new tab. `/follow <url>` instead fetches it through the research scrape pipeline and previews it **inside the panel** — nothing stored until the user hits Capture (tag `link-follow`); links inside a preview chain into further previews |
| **Link expansion (ephemeral)** | When chatting **with page context on**, the page's outgoing links are scored against the question (offscreen cross-encoder on anchor text); the best 1-2 are fetched and inlined next to the page context for that turn, and the model is prompted to link the followed page inline in its reply (opens in-panel on click) rather than fake an `[anchor]` citation for it. Same contract as page context: in-memory TTL cache only, **never saved**, never `[anchor]`-cited |
| **Repo tree context (ephemeral)** | When the discussed page is a repo on GitHub, GitLab, Azure DevOps, or Bitbucket, its file tree is pulled from the host's public API (10-min per-repo cache, skipped over 8k entries; private repos silently skip) and inlined so "where is X?" questions answer from real structure. Never saved |
| **Log highlights (ephemeral)** | When the discussed page reads like a CI/build log (Azure `##[error]` markers, timestamped lines, failure markers), the error/warning lines (+context) are auto-extracted into a LOG HIGHLIGHTS block so "what failed and why?" always sees the actual error text — retrieval selection alone can miss it in huge logs |
| **Research** | Every gathered source is saved as a first-class document and linked to the workspace (keeps citation anchors permanently resolvable); the run also saves the synthesis report and a consolidated `research-sources` list (see RESEARCH-PIPELINE.md) |

Capture destination: Global Lore always; linked to the active workspace when
"Auto-add to active workspace" is ON. `/recall <topic>` links relevant global docs later.

## Extraction salvage — what Readability drops

Readability scores candidates by **prose density**; it exists to find the
article in a news page. Two shapes lose badly, and both fail *silently* —
`article.content` comes back non-empty and plausible, so no fallback fires.

**Specification grids** (`lib/spec-salvage.ts`). A spec sheet is dozens of
two-word cells with no sentences, so it scores near zero. Salvage runs alongside
Readability and appends what it discarded, best source first: JSON-LD (read
before `<script>` is stripped), `<dl>/<dt>/<dd>`, repeated two-or-three-cell
rows, and flat CSS-grid label/value sequences. Layout wrappers are unwrapped up
to 4 levels — real markup nests the row inside a single-child div, and counting
the wrapper's children sees 1, not 2.

Noise guards: >=3 pairs per container, cells short and sentence-free,
`nav`/`footer`/`form` subtrees skipped, rows already in the markdown dropped,
hard row cap.

**Coverage check** (`lib/extraction-quality.ts`). No heuristic extractor works on
every site — Readability is a scoring algorithm and some layout will always score
wrong. What *is* guaranteed is that a bad extraction is **detected**:
`assessCoverage` compares the captured text against the page's own. Below 12% of
a substantial page we sampled rather than captured, and the fuller body text is
used instead. The threshold sits well under normal article loss (70-80% of a page
is legitimately nav/sidebar/footer), so ordinary extraction never trips it.

A ratio is a fact about the numbers rather than about any one site, which is why
it keeps working on sites nobody has tested.

Both run in the content script (live DOM) **and** the parse worker (fetched
HTML). The worker reuses its already-parsed document for the fallback: building
a second full DOM there would defeat the reason the worker exists.

## Gated PDFs

A background fetch is a bare request with no session, so a host that gates
downloads (ResearchGate, most publishers) answers with a verification page
instead of the PDF. The **tab** has a session — the user opened the paper and the
site let them through.

`capturePdfUrl` falls back to `EXTRACT_PDF`, which asks the content script to
fetch the same URL from inside the page so it carries their cookies. This is the
user's own access used on their behalf: if they cannot open the PDF themselves,
neither can this. Nothing here circumvents a check.

`isJunkUrl` treats a PDF as content whatever path serves it. The `/profile/` rule
was written for ResearchGate's HTML profile pages and had been discarding its
full-text papers, which live at
`/profile/<name>/publication/<id>/links/<hash>.pdf`.

## Quality gate (`lib/quality-gate.ts`)

Every page scraped through the research / `/follow` pipeline (`scrapeUrl`)
must pass before indexing:
- anti-bot/captcha interstitials, JS-required, paywalls, login walls,
  error/maintenance pages, cookie walls (pattern checks apply only to short
  pages, so long articles merely *mentioning* "captcha" pass). The interstitial
  patterns are exported as `looksLikeChallengePage` and reused by the extraction
  paths, which need the same question answered for a different reason: the gate
  *rejects* a scraped URL, while a live tab has to explain to the user why the
  page came back empty. One list either way — two would drift the first time a
  provider reworded its block page. (Consolidating them immediately surfaced
  four missing markers, and a pattern matching `verify you are human` but not
  Cloudflare's current `Verifying you are human`.)
- minimum size (200 chars / 50 words),
- OCR-garbage detector for PDF text (alphanumeric ratio).

Blocked publisher pages with a **DOI** (ACM/IEEE/Springer/Wiley) are
recovered via Semantic Scholar metadata instead of dropped.

## Chunker (`lib/chunker.ts`)

Heading-aware sections → paragraph chunks with stable anchors
`d{6}.s{section}.p{para}[.{split}]`. Anti-noise/anti-slip rules:
- YAML frontmatter never indexed,
- link farms, image-only, separator rows, **numeric table soup** (≥40%
  number/bracket tokens) skipped,
- tiny paragraphs merge forward (or into the previous chunk, same section
  only), oversized ones split at sentence boundaries with a 15% slack and
  no tiny tails.

## Frontmatter (`lib/frontmatter.ts`)

Obsidian-compatible YAML: `title`, `type`, `source`, `author`, `captured`,
`created`, `word_count`, `tags` (incl. `source/<domain>`). `splitFrontmatter`
/ `parseFrontmatterFields` are the single shared reader (DocumentView
metadata card, chunker, `/recall` metadata index).
