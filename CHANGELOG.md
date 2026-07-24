# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/);
versions follow the extension manifest.

## [Unreleased]

### Fixed — non-English use

- **Research answered in English regardless of the question's language.** Only
  search-*query* generation carried a language rule; directives, stage briefs,
  reports, the capstone and both revision paths carried none, and the sources are
  overwhelmingly English. The rule now keys off the topic's own language, so it
  covers anything the model can write — Finnish, Kurdish (Sorani/Kurmanji),
  Arabic, CJK — with no list to maintain. Citations, URLs, code and proper nouns
  stay verbatim.
- **Chat did the same on small models.** The language rule was the ninth bullet
  of a long style block, and fast models drop trailing instructions. It now also
  leads every prompt, sandwiching the payload.
- **Enter sent half-composed CJK text.** With a Chinese/Japanese/Korean input
  method, Enter confirms a candidate — every Enter handler treated it as "send",
  shipping a partial message and destroying the composition. Guarded across the
  chat input, message editor, workspace rename and model search.
- **Right-to-left scripts rendered left-aligned.** `dir="auto"` on the inputs and
  both transcript renderers.

### Fixed — capture

- **Specification tables were silently dropped.** Readability scores by prose
  density, so a spec grid scores near zero and disappears — with no error, since
  the extraction "succeeds". Salvaged now from JSON-LD, `<dl>`, div rows and
  CSS-grid label/value sequences, including through layout wrappers.
- **Under-extraction is detected instead of shipped.** Below 12% of a
  substantial page, the fuller body text is used. A ratio is a fact about the
  numbers rather than about any one site.
- **PDFs served under a "profile" path were discarded before any fetch** — this
  is where ResearchGate publishes its full-text papers.
- **PDFs behind a download gate can be captured** by re-fetching from the tab the
  user already opened, which carries their session. Nothing circumvents a check;
  if they cannot open it themselves, neither can this.
- Bot-check interstitials are recognised rather than stored as content. The
  pattern list is now shared with the research quality gate, which immediately
  surfaced four missing markers and one that matched `verify you are human` but
  not Cloudflare's current `Verifying you are human`.

### Added — chat

- **Reasoning models stream their thinking.** `delta.reasoning_content` /
  `delta.reasoning` were parsed and thrown away, so an R1-class model showed
  nothing for 30-120 s and then dumped the answer. Reasoning now streams on its
  own channel, and can never reach the saved transcript or the citation pass.
- **Regenerate an answer; edit a question and re-run.** Both truncate the stored
  transcript and replay the turn. Editing confirms first, naming how many
  messages it discards.
- **A live status line** — real phase, elapsed time, and the tail of the
  reasoning — replacing a static "Thinking…".
- **Village theme** and a working Appearance picker. The theme preference had
  been read since it was added but never written by anything, so the app silently
  followed the OS.

### Changed

- **Reports target ~2000 words instead of ~4000.** `standard` claimed 1800-3000
  while asking for 4-8 sections of 300-700 — which multiplies out to 5600, so an
  obedient model necessarily overshot. Length pressure is now two-sided.
- The side panel reads as a sidebar: content runs to the panel edge, settings are
  flush rows rather than a stack of floating cards.
- Answers are formatted for scanning on every branch. The rules existed but were
  declared after the general-knowledge, web and Wikipedia branches returned, so
  those three had no formatting guidance at all.

### Added — diagnostics

- **Every build carries a timestamp**, shown in Settings → About (panel and
  service worker report separately) and logged by the worker at startup.
  "Did my change load?" was previously unanswerable from inside the extension —
  the panel picks up changes when reopened, while the service worker keeps
  running its old script until the extension is reloaded.
- Version numbers aligned: the manifest said 2.0.0 while both `package.json`
  files said 1.0.0.
