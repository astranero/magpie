# Research Pipeline

Three commands: `/research` (quick, web-only + academic fallback),
`/deepresearch` (staged multi-agent), and `/academic` (the same staged
pipeline over a **papers-only corpus**). All live in
`background/deep-researcher.ts`, orchestrated by `executeResearch` in the
service worker. `/academic` is the deep pipeline plus a
`sourceMode: 'auto' | 'academic'` switch threaded command → service worker →
`runDeepResearch`; the per-stage agent routing itself is pure
(`planStageAgents`).

## Plan negotiation (before any run)

The command posts an interactive **plan card into the chat** (no modal):
`PREVIEW_DEEP_RESEARCH` resolves conversational references ("these papers")
into a standalone topic and drafts sub-questions. While the card is a
draft, normal chat input refines it (`REFINE_RESEARCH_PLAN` — one LLM call
returns the revised topic + questions); typing "start"/"go"/"confirm" or
the card's button launches the run. Draft cards live in UI state only and
survive chat switches; history keeps the command + the final report.

One research run at a time (the crash-resume checkpoint is a singleton);
a second start is **queued**, not rejected — a persisted FIFO
(`lib/research-queue.ts`) drains one run at a time as each finishes. Chat is
NOT blocked during a run (confirmed fixed): streaming chat and research share
the worker via separate abort controllers (chatId vs projectId), and progress
renders as a live card with its own Stop.

**Language rules**: the report language follows REPORT_LANGUAGE (user setting
or auto-detected from query locale). Search queries are generated bilingually
(original language + English) to maximize discovery across sources.

## Settings that shape a run

- **Research depth** (`researchDepth`): Standard / Deep / Exhaustive —
  scales every limit (`lib/research-limits.ts`): URLs per query, academic
  caps (S2/HF/CrossRef), news count, retrieval pool, and **stage count
  (2/8/10)**.
- **Source quality** (`sourceQuality`): `all` vs `high` (authority-domain
  allowlist + DOI/arXiv only; papers need ≥10 citations or ≤1 year old,
  with a starvation guard).
- **Model context window** (`contextTokens`): synthesis packs evidence
  round-robin until ~55% of the window is spent — never a fixed chunk count.

## Deep mode stages (Gemini-style)

1. **Plan**: topic → sub-questions + search queries (checkpointed; a
   context-aware pre-step rewrites vague topics like "these information"
   using recent chat + doc titles).
2. **Stage 1 gather**: WEB + ACADEMIC (Semantic Scholar → HuggingFace →
   CrossRef, deduped, **algorithmically ranked** by citations, citation
   velocity, influential citations, recency, full-text availability, with
   ~30% of slots reserved for newest papers — `lib/paper-rank.ts`) + NEWS
   (Google News RSS) + optional MCP tools, in parallel.
3. **Between stages — reflect** (`reflectOnStage`, one LLM call): updates
   the **living report outline** (sections with evidence notes + fill
   status), emits the structured handoff for the next stage's brief, and
   derives next queries from the outline's thin sections and unresolved
   contradictions (outline–search co-evolution); plus **reference harvesting**
   (`lib/reference-harvest.ts`): arXiv/DOI citations found in source text
   are always followed (through the academic path: full text + BibTeX),
   web links only if their anchor text survives the reranker — capped at
   ⅓ of the stage budget.
4. **Synthesis — section-scoped**: the report is written SECTION BY
   SECTION against the outline (per-section targeted retrieval over all
   gathered sources + the relevant brief excerpts, one streamed call each),
   then a capstone adds the executive overview, a mandatory
   "Contradictions & Open Questions" section, and the Verdict. Degrades to
   the single merge over stage briefs when the outline/sections fail.
   Evidence within each call is balanced across source types (round-robin
   by agent label) with origin tags in headings. Streamed live to the panel
   (`DEEP_RESEARCH_DELTA`); the persisted chat message is the source of
   truth. The report, every scraped source, and the consolidated Research
   Sources list are all saved as project documents; only the in-memory
   Orama index is dropped afterwards (persisted chunks rehydrate from
   IndexedDB on the next search).

Web discovery prefers user-linked search APIs (Tavily/Brave/Serper) and
falls back to the DDG scrape chain (direct → Jina-proxied → `site:`-stripped
retry). Quick mode falls back to academic search when web discovery returns
nothing.

## Academic mode (`/academic`)

The full staged pipeline above (reflect/outline co-evolution, sectioned
synthesis, audit), with the corpus swapped:

- **Papers only**: Semantic Scholar + CrossRef + arXiv + HuggingFace. No web
  scraping, no news, no MCP. The `isAcademicQuery` topic gate is bypassed —
  the command IS the intent.
- **The academic agent runs EVERY stage** (auto mode runs it stage 1 only),
  driven by the reflect queries: stage 1 searches the topic + first queries,
  later stages search what the outline's thin sections still need (≤3 query
  strings per stage — S2 rate-limits keyless callers).
- **Source quality is forced `high`** regardless of the saved setting.
- **Reference harvesting follows arXiv/DOI citations only** — harvested web
  links are dropped, and DOI scrapes are labeled ACADEMIC.
- **Fails honestly**: fewer than 5 papers after stage 1 aborts the run with a
  clear chat message pointing at `/deepresearch` — no silent web fallback.
- **The evaluator is told the corpus is papers-only** (`evaluateReport`
  corpus hint) so it doesn't dock coverage for missing web/news/industry
  sources.
- `sourceMode` is **checkpointed** in the research job and the research
  queue, so crash-resume and queued runs keep the papers-only rules.

## Quality pipeline (audit)

Quality is enforced at four points, in order. There is no single "quality
score" — each layer has its own job:

1. **Discovery filters** (`deep-researcher.ts`): `BLOCKED_DOMAINS` drops
   social/content-farm URLs at search time; `isJunkUrl` drops schema/asset
   URLs; `HIGH_QUALITY_DOMAINS` sorts authority domains first. `sourceQuality:
   'high'` turns the sort into a hard filter (plus ≥10-citation / ≤1-year
   floor for papers, with a starvation guard).
2. **Content gate at ingest** (`lib/quality-gate.ts`): every scraped page
   passes `checkContentQuality` — anti-bot, JS-required, paywall, login-wall,
   error-page, cookie-wall, thin-content. Rejects are never indexed; pages
   with a DOI recover via Semantic Scholar metadata. Garbled PDF extraction
   is detected (`isGarbledPdf`) and LLM-cleaned.
3. **Selection ranking**: academic papers are ranked algorithmically
   (`lib/paper-rank.ts` — citations, velocity, influential citations,
   recency, full-text, landmark-venue prestige, 30% frontier slots); web
   sources get a tiered domain-authority boost (`webDomainAuthority`:
   standards bodies/primary research > canonical docs/empirical UX research
   > gov/edu/quality press) through the retrieval qualityBoost; harvested
   web references must survive the offscreen reranker.
4. **Synthesis packing**: retrieval is BM25+vector hybrid; evidence is
   packed round-robin across agent labels within the context budget, and a
   context-minimum guard aborts rather than synthesizing from nothing.
5. **Post-synthesis verification**: a reranker-based faithfulness pass drops
   citations whose chunk doesn't support the claim (with a >25%
   miscalibration gate that keeps all rather than over-drop), then an
   LLM-judge audit scores five weighted dimensions (depth heaviest; score
   recomputed deterministically from the rubric) and triggers up to two
   revision passes; the audit is appended to the report.

Every source that survives the gate becomes a `SourceRecord` with a quality
**tier**: `high` (authority domain, arXiv/DOI, or ≥10 citations) or
`standard`. Post-gate there is deliberately no "low" tier — rejects never
become records. Tiers are shown in the consolidated **Research Sources**
document (`type: research-sources`) saved alongside every report: browsable
in Lore, saved `enabled: false` and never vector-indexed so the link table
can't pollute retrieval or citations. Report citations (`[anchor_id]`)
always resolve to the captured primary documents, not to this list.

## Crash safety

Job checkpoint in `chrome.storage.local` (plan, spec, phase, logs, evolved
stage queries, stage briefs, the living outline + handoff, gathered doc ids,
and per-section synthesis drafts — a worker death mid-final-synthesis resumes
without rewriting finished sections), scraped pages in `ResearchJobCacheDB`. A 20 s heartbeat keeps the
worker alive through long LLM calls **and** timestamps liveness. On worker
start, auto-resume runs only if: job `active`, age < 12 h, and < 12 prior
resume attempts (then it fails loudly into the chat). Cancel/complete clear
the job. (The fresh-heartbeat skip was deliberately removed — an active job
always means resume.)
See `MV3-PERSISTENT-AGENT-STATE.md` for the war story.
