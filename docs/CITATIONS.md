# Citations

## Anchor grammar

Every chunk carries a stable anchor assigned at chunk time:

```
d{6-char-doc-id}.s{sectionIdx}.p{paragraphIdx}[.{splitIdx}]
e.g.  d4b8395.s1.p0   d9f36f9.s18.p1.2
```

`CITATION_REGEX` (`lib/citations.ts`):
`/\[([a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?)\]/g`.

## Prompt contract

`CITATION_SYSTEM_PROMPT` + `buildCitationContext` wrap each retrieved chunk
in `<c>anchorId</c>` tags under a `[Source: title]` header (char-budgeted).
Rules the model must follow: cite every factual claim, one anchor per
bracket (`[a][b]`, never `[a, b]`), never fabricate anchors, only cite a
passage that directly supports the claim, say "not found in your sources"
when it isn't. When retrieval returns nothing, chat switches to a
general-knowledge fallback that must announce itself in the first line.

## Rendering (ChatView)

1. `normalizeCitations` splits model-emitted groups `[a, b]` → `[a][b]`.
2. Anchors become numbered chips (ordered by first appearance) — counting
   both raw `[anchor]` markers and anchors already carried inside
   `[[n](#cite:anchor)]` links (`linkifyReportCitations` pre-linkifies saved
   research reports this way, so a chip always jumps to the saved source
   chunk, never the external URL). Resolution against the chunk store is
   debounced 300 ms (streaming); an anchor that fails to resolve still
   renders as a chip, falling back to a generic "Source: anchor" label whose
   click is a no-op.
3. A grouped **Sources** footer lists cited documents, one line per source
   with its citation number(s) and a title link (no per-anchor snippet —
   dropped as noise on long research reports).

## Click-through highlighting (DocumentView)

Everything shares **one coordinate space: the frontmatter-stripped body**
(`splitFrontmatter`) — matching against raw content while rendering the
stripped body once shifted every highlight by the YAML length (bug class
now guarded by E2E). Locating the cited chunk in the document:

1. exact `indexOf(chunkText)`,
2. match against `cleanContent`-normalized text, mapped back to the raw body
   via a whitespace-flexible probe (first 120 chars),
3. whitespace-flexible regex (pattern capped at 600 chars),
4. opening-sentence anchor (first 100 chars),
5. graceful "[CITED] Position not found — doc may have changed" callout
   showing the chunk text.

Text-matching (not stored offsets) because content-cleaner normalization
means chunk text can drift from stored content; it also survives re-chunking.

## Question intent resolution

Follow-up questions ("how to use it?", "I mean the skill Pro Max") carry no
retrieval signal. `resolveQuestionIntent` (service worker) rewrites them into
standalone questions with one small LLM call — gated by pure heuristics in
`lib/query-intent.ts` (pronouns/deictics, continuation openers, ≤3 words;
never on a chat's first message or slash commands). The rewrite drives
retrieval, page-section selection, and link scoring ONLY — the model still
receives the user's own words with full history.

## Retrieval gates that protect citation quality

Rerank (cross-encoder logits — `bge-reranker-v2-m3` primary, `ms-marco-MiniLM`
fallback): absolute gate at −4 (junk floor −8, at most 2 borderline results
when nothing clears the gate — an irrelevant-padding-free contract) plus a
relative **score cliff** (drop >7 logits below a confident top hit). Fewer-but-
relevant chunks are the main defense against "cited but irrelevant".

> ⚠️ The −4 / −8 thresholds (`RERANK_MIN_SCORE` / `RERANK_JUNK_SCORE` in
> `lib/vector-store.ts`) are calibrated to **ms-marco-MiniLM** logit space, as
> the code comments still state. They have not been re-tuned for
> `bge-reranker-v2-m3`, whose logits sit on a different scale — revalidate the
> gate against the primary model.
