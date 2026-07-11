# Test Audit — 2026-07-11

Phase A of `PLAN-v1-full.md`. Question asked: are the machine-generated tests
*correct*, not merely green? Method: (1) confession-comment sweep, (2) contract
review per suite, (3) mutation kill-matrix.

## Suite verdicts

| Suite | Verdict | Notes |
|---|---|---|
| `chunker` | sound (1 wart) | One assertion pins `d1.s1.p0` because an empty phantom `s0` "Document" section exists for docs starting with a heading. Harmless (anchors only need stability/uniqueness); fixing would shift anchors for all new docs for zero gain. Comment noise removed from history: one test previously asserted YAML-indexing as spec — rewritten during the frontmatter-strip fix. |
| `citations` | sound | Real contract tests incl. regex boundary cases (9-char doc-id limit), budget cap, prompt-contract checks. |
| `content-cleaner`, `content-cleaner-academic` | sound | Real inputs, real assertions. |
| `frontmatter` | sound | Escaping, tags, domain-tag derivation. |
| `frontmatter-parse` | **was WRONG → rewritten** | Tautology: declared its own local regex and tested its own arithmetic — imported zero product code, could never fail. Root cause: the logic it wanted to test lived inline in `DocumentView`. Fixed by hoisting `splitFrontmatter` / `parseFrontmatterFields` into `lib/frontmatter.ts` (now consumed by DocumentView **and** chunker) and rewriting the suite against the real helpers, incl. a round-trip with `buildFrontmatter` and the coordinate-space invariant. |
| `quality-gate` | weak → strengthened | Pattern redundancy masked mutations (removing `/just a moment/` stayed green because the fixture also matched two other patterns). Added per-phrase isolation tests. |
| `bibtex` | sound | Key format, entry-type switching, escaping, absent fields. |
| `paper-rank` | weak → strengthened | Comparative tests couldn't isolate the velocity term (it correlates with citations). Added a formula-property assertion: equal-citation papers of different ages must diverge by more than the recency term alone. |
| `research-store` | sound | Heartbeat/staleness gates both sides, storage mock is infrastructure not logic. |
| `semaphore` | sound | |
| `commands` | sound | Sanitization, shadowing, matching, palette, help. |
| `mcp-client` | sound | JSON+SSE response parsing, tool filtering. |
| `deep-researcher` | sound | Pure helpers only (context building, URL extraction, LLM-output parsing); mocks are import-isolation, not logic replacement. |
| `scrape-fallback` | sound (thin) | DOI extraction only. |
| `rerank-gate` | **new** | The relevance gate was untestable inside `searchSessionChunks` (chrome+Orama coupling) → extracted `gateRerankedChunks` as a pure exported function. |

## Mutation kill-matrix

| # | Mutation | First run | After fixes |
|---|---|---|---|
| M1 | `RERANK_MIN_SCORE` sign flip | **SURVIVED** | KILLED (2 tests) — gate extracted pure + `rerank-gate` suite |
| M2 | `MIN_CHUNK_CHARS` → 0 | KILLED (1) | — |
| M3 | `CITATION_REGEX` `.p` → `.q` | KILLED (7) | — |
| M4 | `/just a moment/` pattern removed | **SURVIVED** | KILLED (1) — per-phrase isolation tests |
| M5 | BibTeX key drops year | KILLED (3) | — |
| M6 | paper-rank velocity term removed | **SURVIVED** | KILLED (1) — formula-property test |
| M7 | custom-skill shadow-check removed | KILLED (1) | — |
| M8 | `JOB_MAX_AGE_MS` → 0 | KILLED (2) | — |

All mutations reverted; final suite: **154/154 green**.

## Takeaways

1. The one truly broken suite (`frontmatter-parse`) was broken because the
   logic under test wasn't extractable — same lesson as the rerank gate.
   **Untestable placement produces tautological tests.**
2. Redundant defensive patterns (quality-gate) hide dead patterns from
   comparative tests; isolation tests per pattern are required.
3. Composite scoring formulas (paper-rank) need property assertions, not just
   input/output comparisons — terms that correlate can't be isolated by
   examples alone.
