# Archive

Files moved out of the working tree because they're finished, superseded, or
unrelated to the Magpie extension itself — kept for history rather than
deleted. `git log --follow` on any file here still shows its original history.

- **`scratch/`** — `ai_refs.txt` / `vault_refs.txt` / `vault_refs.json`: leftover
  `grep` dumps from the pre-rebrand "AI Research Assistant" → "Vault" → "Magpie"
  naming audit, never referenced by code or docs. `setup-ollama.sh`: already a
  no-op stub in the source ("Magpie no longer manages Ollama directly") — dead
  weight, not a live script.
- **`research/`** — a one-off market-validation research exercise
  (`2026-07-20-ai-market-validation-tools-research/` planning files + its
  `ai-market-validation-tools-transition.md` deliverable) run in this same
  working directory but unrelated to the extension codebase. The deliverable
  exists, so the exercise is complete even though its own tracker still showed
  phase 6 as "in_progress".
- **`design-critique/`** — a dated snapshot from an automated UI critique pass
  (`2026-07-10-sidepanel-critique.md`), not a living doc.
- **`PROFILE_README.md`** — the user's personal GitHub profile page; unrelated
  to this project, was accidentally sitting in the repo root.
- **`Magpie-battlecard-2026-07-15.html`** — a competitive-intelligence artifact
  (vs. NotebookLM) generated during product research, not project code or docs.
