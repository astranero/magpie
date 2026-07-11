# Research Pipeline

`/research` (quick, web-only + academic fallback) and `/deepresearch`
(staged multi-agent). Both live in `background/deep-researcher.ts`,
orchestrated by `executeResearch` in the service worker.

## Plan negotiation (before any run)

The command posts an interactive **plan card into the chat** (no modal):
`PREVIEW_DEEP_RESEARCH` resolves conversational references ("these papers")
into a standalone topic and drafts sub-questions. While the card is a
draft, normal chat input refines it (`REFINE_RESEARCH_PLAN` — one LLM call
returns the revised topic + questions); typing "start"/"go"/"confirm" or
the card's button launches the run. Draft cards live in UI state only and
survive chat switches; history keeps the command + the final report.

One research run at a time (the crash-resume checkpoint is a singleton —
the worker rejects a second start). Chat is NOT blocked during a run:
streaming chat and research share the worker via separate abort
controllers (chatId vs projectId), and progress renders as a live card
with its own Stop.

## Settings that shape a run

- **Research depth** (`researchDepth`): Standard / Deep / Exhaustive —
  scales every limit (`lib/research-limits.ts`): URLs per query, academic
  caps (S2/HF/CrossRef), news count, retrieval pool, and **stage count
  (2/4/6)**.
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
3. **Between stages**: LLM gap analysis over evidence-so-far → findings +
   new queries targeting only the gaps; plus **reference harvesting**
   (`lib/reference-harvest.ts`): arXiv/DOI citations found in source text
   are always followed (through the academic path: full text + BibTeX),
   web links only if their anchor text survives the reranker — capped at
   ⅓ of the stage budget.
4. **Synthesis**: evidence balanced across source types (round-robin by
   agent label), origin tags in headings, confidence markers, analyst notes
   from stages as non-citable context. Streamed live to the panel
   (`DEEP_RESEARCH_DELTA`); the persisted chat message is the source of
   truth. The report, every scraped source, and the consolidated Research
   Sources list are all saved as project documents; only the in-memory
   Orama index is dropped afterwards (persisted chunks rehydrate from
   IndexedDB on the next search).

Web discovery prefers user-linked search APIs (Tavily/Brave/Serper) and
falls back to the DDG scrape chain (direct → Jina-proxied → `site:`-stripped
retry). Quick mode falls back to academic search when web discovery returns
nothing.

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
   recency, full-text, 30% frontier slots); harvested web references must
   survive the offscreen reranker.
4. **Synthesis packing**: retrieval is BM25+vector hybrid; evidence is
   packed round-robin across agent labels within the context budget, and a
   context-minimum guard aborts rather than synthesizing from nothing.

Every source that survives the gate becomes a `SourceRecord` with a quality
**tier**: `high` (authority domain, arXiv/DOI, or ≥10 citations) or
`standard`. Post-gate there is deliberately no "low" tier — rejects never
become records. Tiers are shown in the consolidated **Research Sources**
document (`type: research-sources`) saved alongside every report: browsable
in Lore, saved `enabled: false` and never vector-indexed so the link table
can't pollute retrieval or citations. Report citations (`[anchor_id]`)
always resolve to the captured primary documents, not to this list.

## Crash safety

Job checkpoint in `chrome.storage.local` (plan, phase, logs, evolved stage
queries), scraped pages in `ResearchJobCacheDB`. A 20 s heartbeat keeps the
worker alive through long LLM calls **and** timestamps liveness. On worker
start, auto-resume runs only if: job `active`, heartbeat stale (fresh =
clearJob lost a race — skip), age < 12 h, and < 3 prior resume attempts
(then it fails loudly into the chat). Cancel/complete clear the job.
See `MV3-PERSISTENT-AGENT-STATE.md` for the war story.
