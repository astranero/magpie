# Distribution Plan

How Magpie gets from "works on my machine" to users. The product analysis
(2026-07): the winnable segment is the one NotebookLM structurally can't serve —
privacy-first researchers, local-LLM users, people who need verifiable citations
and data ownership. Distribution is 80% of the difficulty; this plan treats it
as the product's next feature.

## Positioning (one sentence everywhere)

> **Magpie — the research assistant that never phones home.** Capture anything
> you read, build a permanent local library, run deep research with citations
> that are machine-verified down to the exact passage — with any model you
> choose, including fully local.

Three claims, each demoable and each structurally impossible for cloud rivals:
1. **Local-first** — your corpus is markdown + IndexedDB on your disk.
2. **Verified citations** — a reranker checks every claim against its source
   passage before the report ships. Show a citation being *rejected*.
3. **Your model** — any OpenAI-compatible key, a local endpoint (e.g. Ollama)
   by base URL, or GitHub Copilot SSO.

## Phase 0 — Launch readiness (gate before any announcement)

- [x] Onboarding: BYOK (OpenAI-compatible endpoint) or GitHub Copilot SSO.
      NOTE: the earlier Ollama / built-in-Gemini auto-detection was removed
      (see the "remove local models" change) — the r/LocalLLaMA "autodetect"
      hook below now needs re-messaging or the feature restored.
- [ ] README rewrite around the three claims + 60-second GIF (capture → ask →
      click citation → highlighted passage).
- [ ] Demo video (≤2 min): run `/deepresearch`, watch the outline evolve, open
      the report, click a citation, show the faithfulness pass dropping a bad
      one. The invisible features must be made visible.
- [ ] Chrome Web Store listing: name, 5 screenshots (panel, report, citation
      jump, settings/providers, library), privacy-practices form (easy — no
      data collected), category: Productivity/Tools.
- [ ] Repo hygiene: LICENSE (present), CONTRIBUTING.md, issue templates,
      `SECURITY.md` already strong — link it prominently (trust signal).
- [ ] A landing page (GitHub Pages is fine): the sentence, the GIF, three
      claims, install button, "how it compares" table (honest — from the
      battlecard, including where NotebookLM wins).

## Phase 1 — Community launch (weeks 1-4)

Order matters; each launch feeds the next:

1. **r/LocalLLaMA** — the highest-affinity audience on the internet for
   "local-first + BYO model + Ollama autodetect". Post as a build story, not an
   ad: "I built a research assistant that runs its embeddings and reranker
   in-browser and verifies citations before showing the report."
2. **Hacker News (Show HN)** — the MV3 war stories ARE the post: "Show HN:
   Magpie — local-first deep research in a Chrome extension (surviving MV3's
   30-second service worker)". Engineering depth is what HN rewards; the
   RagTab author hit the same wall publicly — that's the conversation to join.
3. **Product Hunt** — after HN (PH audiences follow HN). Needs the video.
4. **X/Bluesky academic + AI corners** — the `/academic` mode + BibTeX story
   for the Zotero/arXiv crowd.
5. **Awesome-list PRs** — awesome-web-agents, awesome-chrome-extensions,
   awesome-local-ai, Ollama community integrations page. Slow drip, free.

Content backlog (one post each, staggered weekly):
- "How we made citations machine-verified" (the faithfulness pass).
- "Running a multi-hour agent in a service worker that dies every 30 s"
  (MV3-PERSISTENT-AGENT-STATE.md is already written — publish it).
- "Outline–search co-evolution in a browser extension" (the SOTA pipeline).
- "Every byte that leaves your machine" (walk SECURITY.md's egress table).

## Phase 2 — Retention + word of mouth (months 2-3)

- In-product: after a first successful research run, one quiet prompt —
  "Useful? Star the repo / share the report". Never nag.
- Ship an **export showcase**: one-click "share this report as HTML/Markdown"
  (verified citations intact) — every shared report is an ad.
- GitHub Discussions as the support channel; issues answered fast beats any
  marketing spend.
- Track the only metrics that matter early: weekly active panels (local
  counter, opt-in telemetry NEVER — publish install/star/review counts only).

## Phase 3 — Moats that compound (months 3+)

- **Open-source trust**: the code IS the privacy claim. Reproducible builds if
  feasible; pin the store build to a tagged commit.
- **Firefox/Edge ports** widen the moat vs Chrome-only rivals (Merlin's
  differentiator) — Edge is nearly free, Firefox needs MV3 parity checks.
- **Obsidian bridge** (folder sync already exists — document the workflow):
  taps the largest local-first community without building a plugin.
- Optional revenue later (keep free core): paid sync/team features, never
  paywalled privacy or verification.

## Risks

- **Chrome Web Store review latency/rejection** — the extension requests
  `<all_urls>`; justify in the listing (capture) and expect 1-2 weeks.
- **Platform squeeze** — Chrome ships deeper built-in Gemini features; answer
  is the BYOK + verification story, not feature racing.
- **Solo-dev support load** — scraping breaks weekly somewhere; the crash-log
  breadcrumbs + GitHub issue template asking for them keep triage cheap.
- **Name collision** — "Magpie" is common; check store/trademark before the
  listing is public.
