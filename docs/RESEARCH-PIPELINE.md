# Research Pipeline

`/research` (quick, web-only + academic fallback) and `/deepresearch`
(staged multi-agent). Both live in `background/deep-researcher.ts`,
orchestrated by `executeResearch` in the service worker.

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
   truth. Report saved as a document; source chunks evicted from the index.

Web discovery prefers user-linked search APIs (Tavily/Brave/Serper) and
falls back to the DDG scrape chain (direct → Jina-proxied → `site:`-stripped
retry). Quick mode falls back to academic search when web discovery returns
nothing.

## Crash safety

Job checkpoint in `chrome.storage.local` (plan, phase, logs, evolved stage
queries), scraped pages in `ResearchJobCacheDB`. A 20 s heartbeat keeps the
worker alive through long LLM calls **and** timestamps liveness. On worker
start, auto-resume runs only if: job `active`, heartbeat stale (fresh =
clearJob lost a race — skip), age < 12 h, and < 3 prior resume attempts
(then it fails loudly into the chat). Cancel/complete clear the job.
See `MV3-PERSISTENT-AGENT-STATE.md` for the war story.
