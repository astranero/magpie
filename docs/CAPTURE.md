# Capture

All ingestion paths converge on: markdown → quality gate → frontmatter →
chunk → embed → save. Nothing enters the library implicitly.

## Paths

| Source | Route |
|---|---|
| **Web page** | Content script: Readability + Turndown → markdown (fallback: script injection; last resort: Jina Reader `r.jina.ai`) |
| **YouTube watch page** | Content script: timedtext API; empty/PO-token response falls back to scraping the player's own transcript panel |
| **PDF by URL** (incl. extension-less like `arxiv.org/pdf/…` — detected via HEAD content-type) | `OFFSCREEN_PARSE_PDF_URL`: the offscreen document fetches (size-scaled timeout: 30 s + 3 s/MB, cap 5 min) and parses with pdf.js — bytes never cross `sendMessage` (~64 MB cap). Column-aware line building fixes two-column papers; citation brackets re-joined; scanned pages → canvas → vision-model OCR; 800-page cap |
| **Local `.md` files/folder** | File System Access picker; relative images inlined as data URLs (`lib/import-helpers.ts`); existing frontmatter preserved |
| **Local PDF/images** | Base64 path (guarded: >48 MB errors with size instead of OOM), async with BroadcastChannel progress; images described by the vision model |
| **Right-click** | "Capture page to Library" / capture selection |
| **Research** | Every gathered source is saved as a first-class document and linked to the workspace (keeps citation anchors permanently resolvable); the run also saves the synthesis report and a consolidated `research-sources` list (see RESEARCH-PIPELINE.md) |

Capture destination: Global Lore always; linked to the active workspace when
"Auto-add captures" is ON. `/recall <topic>` links relevant global docs later.

## Quality gate (`lib/quality-gate.ts`)

Every scraped page must pass before indexing:
- anti-bot/captcha interstitials, JS-required, paywalls, login walls,
  error/maintenance pages, cookie walls (pattern checks apply only to short
  pages, so long articles merely *mentioning* "captcha" pass),
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
