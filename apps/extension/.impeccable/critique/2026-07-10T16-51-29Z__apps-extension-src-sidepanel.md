---
target: apps/extension/src/sidepanel
total_score: 22
p0_count: 1
p1_count: 2
timestamp: 2026-07-10T16-51-29Z
slug: apps-extension-src-sidepanel
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Research state well-surfaced; PDF/image async import has no progress signal |
| 2 | Match System / Real World | 2 | Workspace/Session/Library three names for overlapping concepts; slash commands undiscoverable |
| 3 | User Control and Freedom | 2 | No undo; delete doc fires instantly; window.confirm() for workspace delete |
| 4 | Consistency and Standards | 2 | border (1px) on doc cards vs border-2 everywhere else |
| 5 | Error Prevention | 2 | No API key guard before /deepresearch; delete has zero confirmation |
| 6 | Recognition Rather Than Recall | 2 | Slash commands invisible until typed; Remove vs Delete visually identical |
| 7 | Flexibility and Efficiency | 3 | Rich slash commands and research modes; no keyboard view-switching |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined system; duplicate research status indicators |
| 9 | Error Recovery | 1 | "check Settings" as full recovery guidance; manifest.json exposed to users |
| 10 | Help and Documentation | 2 | /help exists but invisible; placeholder disappears on focus |
| **Total** | | **22/40** | **Acceptable — significant improvements needed** |

## Anti-Patterns Verdict
- LLM: Not AI-slop in first-order sense. Deliberate terminal aesthetic held consistently. Two tells: border-l-4 callouts at citation reveal, window.confirm() for delete.
- Detector: 2 confirmed side-tab violations in DocumentView.tsx lines 143, 188. Index.css clean.

## Priority Issues
- [P0] CSS token duplication in index.css (oklch block overwritten by HSL block)
- [P1] border-l-4 border-primary callouts in DocumentView — banned pattern at core UX moment
- [P1] Three destructive actions with zero recovery (delete doc, workspace delete with window.confirm, clear chat)
- [P2] Remove vs Delete visually identical, semantically opposite
- [P2] Slash commands invisible — product's full value layer undiscoverable

## Persona Red Flags
- Alex: No keyboard view-switching, delete fires instantly on click, no bulk doc toggle
- Sam: Citation chips are span/onClick not button — not keyboard focusable; no aria-label on page context toggle; global no-scrollbar on * selector
- Dana (researcher): No per-card workspace indicator; workspace name styled as form input not destination

## Minor Observations
- text-[9px] below legible floor in DocumentView and ChatView
- text-blue-400 for SUCCESS log (not in vocabulary, should be green-400)
- bg-black hardcoded in research terminal
- border-b (1px) in SourcesView line 60 vs border-b-2 system standard
- Emoji in toasts (📄, 🖼️) inconsistent with mono vocabulary
