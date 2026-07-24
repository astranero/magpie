# Design System

## Theme

**Magpie plumage, theme-aware.** The extension renders inside a browser side panel — a narrow instrument, not a canvas. Three palettes ship: the default **plumage light** (`:root`), **plumage dark** (`.dark`, "the plumage at night"), and **village** (`.village`) — a warm storybook light theme of sun-warmed plaster, moss-green `primary`, geranium `rule` and terracotta `highlight`, with a rounder `--radius`, warmer shadows and a system-serif display voice. The class is toggled on `<html>` by a small script in `main.tsx`, following the OS colour scheme unless overridden in Settings → Appearance. Village is a LIGHT theme, not a light/dark axis: `.dark` and `.village` are mutually exclusive (both are single-class selectors over the same tokens, so if both landed the winner would be CSS source order, not the user's choice — `lib/theme.ts` owns that rule and is unit-tested). The palette is a cool feather-white / blue-black-ink ground with an iridescent teal-blue `primary` (wing sheen), a violet `rule` accent, and an amber `highlight` marker — not monochrome. Corners are soft (`--radius: 0.375rem`), borders are thin (1px), and shadows are a subtle blurred `.shadow-card`, not hard offsets. A gradient hairline (teal into violet, `.card-rule`) runs under the app header — its own code comment calls it "used once" as the brand signature; a separate functional fade-to-transparent gradient is also used to cue an expandable/collapsed long chat message. Warmth is still carried by semantic state (green/emerald = success or live, red = destructive / error, amber = pending), but typography is sentence-case sans-serif for UI chrome; monospace is demoted to data (model names, URLs, timestamps, code).

---

## Color

All tokens use HSL via CSS custom properties consumed by Tailwind (`hsl(var(--token))`), defined in `src/sidepanel/index.css`. **Plumage light is the default theme** — the `:root` block below is what ships unless `.dark` or `.village` is toggled on `<html>` (OS preference, or the Settings → Appearance override). Both override blocks redefine the same token names, so nothing downstream needs to know which palette is live. `.village` is declared AFTER `.dark` on purpose — equal specificity means source order settles a tie.

### Active tokens (light theme — default)

| Role | Token | Value | Hex approx |
|---|---|---|---|
| Background | `--background` | `hsl(210 33% 98%)` | `#F8FAFC` |
| Foreground / ink | `--foreground` | `hsl(226 30% 13%)` | `#171C2B` |
| Card surface | `--card` | `hsl(0 0% 100%)` | `#FFFFFF` |
| Muted surface | `--muted` | `hsl(215 22% 94%)` | `#ECEFF3` |
| Muted text | `--muted-foreground` | `hsl(222 14% 44%)` | `#606A80` |
| Primary (action / accent) | `--primary` | `hsl(200 85% 34%)` — wing-sheen teal-blue | `#0D6FA0` |
| Primary foreground | `--primary-foreground` | `hsl(210 40% 98%)` | `#F8FAFC` |
| Border | `--border` | `hsl(216 18% 88%)` | `#DBDFE6` |
| Input border | `--input` | same as border | `#DBDFE6` |
| Ring (focus) | `--ring` | same as primary | `#0D6FA0` |
| Destructive | `--destructive` | `hsl(0 72% 46%)` | `#CA2121` |
| Rule (signature accent) | `--rule` | `hsl(262 65% 56%)` — violet sheen | `#7B46D8` |
| Highlight (active/pending marker) | `--highlight` | `hsl(41 96% 50%)` — amber | `#FAAC05` |

The `.dark` class (applied on `<html>`) overrides every token above with a "plumage at night" set — e.g. `--background: hsl(228 24% 8%)` (`#101119`, deep blue-black, never pure black) and `--primary: hsl(197 75% 58%)` (`#44B7E4`) — see `index.css` for the full dark block.

### Semantic state colours (direct Tailwind / inline)

| State | Class / value | Notes |
|---|---|---|
| Success / connected / copied | `text-emerald-500` / `bg-emerald-500` / `text-green-*` | Toasts, connection status dots, "Copied" confirmation |
| Pending / warming up | `bg-amber-500` (dot), `text-highlight` (amber token) | Auth-poll status dot; the field log's latest line |
| Error / failed | `text-red-500` / `text-red-600 dark:text-red-400` | Failed plan card, error toasts, error icon chip |
| Destructive action | `text-destructive` `border-destructive/40` `hover:bg-destructive/20` | Delete / unlink buttons (shadcn `Button` `destructive` variant) |

The research log no longer colour-codes individual lines by an `[ERROR]`/`[WARNING]`/`[SUCCESS]` tag prefix (see "Field log" under Components) — only the most recent line is tinted, with the `--highlight` amber token.

### Color strategy: Restrained, not monochrome

A cool, mostly-neutral surface (feather-white / blue-black ink) carries the panel; the teal-blue `primary` is the dominant accent, with the violet `rule` reserved for the one signature gradient hairline and amber `highlight` reserved for "the shiny/active thing." Color otherwise enters for semantic state (green/emerald = success or live, red = error/destructive, amber = pending).

---

## Typography

Single family throughout. No pairing.

| Role | Spec |
|---|---|
| Font family | `Geist Variable` (variable font, imported via `@fontsource-variable/geist`) |
| Font stack | `'Geist Variable', sans-serif` (base `--font-sans`); `.font-display` extends it with `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` for report/empty-state headings |
| UI chrome labels | Sentence case, `font-medium` / `font-semibold` sans — mono is demoted to data, not used for general chrome |
| Section titles | `font-semibold text-sm` (see `Section.tsx`) |
| Button text | `text-sm font-medium` (shadcn `Button`, sentence case, no forced uppercase) |
| Body / chat prose | `text-sm`, `prose prose-sm dark:prose-invert` via `@tailwindcss/typography` |
| Micro / data meta | `font-mono` at `text-[8px]`–`text-[11px]` for timestamps, word counts, model names, URLs, citation chips, code |
| Code / math | KaTeX (`katex/dist/katex.min.css`) for LaTeX in chat; inline `<code>` in prose |

**Type scale is fixed, not fluid.** This is a narrow-panel tool; clamp-based fluid sizing would behave incorrectly at panel width.

---

## Shape & Border

- `--radius: 0.375rem` (6px) — soft corners are the intended default; most components round explicitly with `rounded-lg` / `rounded-md` / `rounded-xl` / `rounded-full` in their own className. The base shadcn/Base-UI primitives (`Button`, `Input`, `Select`) still carry a legacy `rounded-none border-2` default in their own source (commented "Tailwind v3-compatible, AGENT_WORKSPACE design language") — most call sites override it via `className` (Tailwind-merge wins), but not all: a handful of `<Button>` usages (e.g. `DocumentView`'s plain "Back" button, `LoreView`'s Lore/Workspace tab toggle and its Drive sync/import buttons) pass no `rounded-*` override and still render sharp-cornered with a visible 2px border — a live inconsistency in the current UI, not a deliberate design choice.
- `border` (1px) is the standard border weight everywhere else in the actual UI (cards, sections, inputs, popovers); `border-2` survives only on the base-primitive default described above and on the small set of un-overridden buttons.
- `border-border` default; `border-primary` / `border-primary/50` on focus / active / citation-highlight states; `border-destructive/40` on the destructive button variant.

---

## Elevation & Shadow

One soft shadow style used consistently across cards, sections, toasts, and popover surfaces — a small utility class, not an inline arbitrary value:

```css
.shadow-card {
  box-shadow: 0 1px 2px hsl(226 30% 13% / 0.05), 0 2px 8px hsl(226 30% 13% / 0.07);
}
```

The code comment above it in `index.css` is explicit: *"Soft feather shadow — replaces the old hard 4px offset blocks."* There is no remaining `shadow-[4px_4px_0_0_...]` or `shadow-primary/10`/`shadow-primary/20` usage anywhere in `src/sidepanel`.

---

## Spacing & Layout

- Panel width: fixed 400px (Chrome side panel constraint)
- Panel height: `h-screen`, `overflow-hidden` on root
- Internal layout: `flex flex-col` shell; header + `flex-1 overflow-hidden` main + bottom nav
- Padding: `px-3.5 py-2.5` (app header), `px-4 py-3` (settings section header) / `px-4 pb-4 pt-1` (its body), `p-3` (chat input)
- Density is high — the panel is narrow. Use `gap-2` / `gap-3` between elements, `space-y-1` inside lists.
- Scrollbars are hidden only where explicitly opted in via the `.no-scrollbar` utility class (`overflow-y-auto no-scrollbar`); the global `* { scrollbar-width: none }` rule was removed — it broke keyboard scrollability on overflow regions and failed WCAG 2.1 SC 1.4.13.

---

## Components

### Shell structure

```
<div class="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
  <Header>          <!-- workspace selector, rename, delete -->
  <main class="flex-1 flex flex-col overflow-hidden relative bg-background">
    <!-- toast (absolute, centered top) -->
    <!-- view content: Sources (Lore) | Document | Chat | Settings -->
  </main>
  <Navbar>          <!-- Sources | Chat | Config tab bar -->
</div>
```

`.dark` / `.village` are not hardcoded here — they're toggled on `<html>` by `main.tsx` based on OS preference / the Theme setting (see Theme, above).

The view container carries **no gutter**. A side panel is a wall of the browser, not a card floating inside one, so content runs to the panel edge and each view owns its own padding. `<main>` also carries no bottom border — the navbar's `border-t` already draws that line.

### Header / workspace selector

- `header`: `card-rule flex items-center px-3.5 py-2.5 bg-card gap-2` (the `card-rule` gradient hairline runs along the bottom edge; there is no separate uppercase label above the selector)
- Select trigger: `h-8 border-none shadow-none bg-transparent ... text-sm font-semibold` (borderless, transparent, sentence case)
- Rename button: `text-muted-foreground hover:text-primary p-2` + `<Edit2 size={14} />`
- Delete button: two-step inline confirm — `text-muted-foreground hover:text-destructive`, then on first click becomes a `Delete?` text pill (`text-destructive bg-destructive/10`) armed for 3s; `<Trash2 size={14} />` shown only when ≥2 workspaces
- A `PanelRightClose` button on the right collapses the side panel

### Bottom navigation

- Icon + label buttons in a `nav` (`bg-card border-t border-border/60 shadow-sm`), NOT equal-width bordered tabs — no separators
- Each tab: icon in a `rounded-lg` container (`bg-primary/10` + slight scale when active), sentence-case `font-display font-medium text-[10px]` label below
- Active state: `text-primary`, plus a small rounded underline indicator (`w-8 h-[2px] rounded-full bg-primary`) that fades/scales in
- A pulsing dot (`animate-ping` + solid `bg-primary`) badges the Chat tab while research is running for the active workspace

### Buttons (shadcn `Button`, `cva` variants)

| Variant | Style |
|---|---|
| default | `bg-primary text-primary-foreground border-primary hover:bg-primary/80` |
| outline | `border-border bg-background hover:bg-muted hover:text-foreground` |
| secondary | `bg-secondary text-secondary-foreground border-secondary hover:bg-secondary/80` |
| ghost | `hover:bg-muted hover:text-foreground` |
| destructive | `bg-destructive/10 text-destructive border-destructive/40 hover:bg-destructive/20` |
| link | `text-primary underline-offset-4 hover:underline` |

The base component still defaults to `rounded-none border-2 border-transparent` (see Shape & Border), and most call sites override the radius via `className` (`rounded-lg` etc.) so buttons read as soft-cornered — but a few don't override it and still render sharp-cornered, so this isn't fully consistent yet. All buttons: `transition-colors`, `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1`.

### Cards / document rows

- `group relative flex flex-col gap-1.5 p-2.5 rounded-lg border transition-all duration-200`, with an accent border/tint (`border-primary/20 bg-primary/[0.01]`) when the source is enabled vs. a plain `border-border bg-card/40 opacity-80` when muted
- Action row: `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity` (hover-reveal pattern, now also keyboard-reachable via `focus-within`)
- Per-doc enable/mute toggle is a small pill switch (`rounded-full`), not the larger Settings-style switch described under "Toggle switch" below

### Section / collapsible

- Outer: `border-b border-border/70 last:border-b-0` — a FLUSH ROW, not a card. The old card treatment (`rounded-lg border bg-card shadow-card`) spent scarce width on chrome and made the panel read as a box floating inside the browser; sections now run edge to edge, separated by one hairline, as native sidebars do.
- Header trigger: `sticky top-0 z-10 w-full flex items-start gap-2 px-4 py-3 text-left bg-background hover:bg-accent/50 transition-colors` — sticky so the section you're inside stays named while you scroll. The background must stay opaque or headers ghost over the content they pin above.
- Title: `font-semibold text-sm` (sentence case, no longer mono/uppercase); subtitle `text-[11px] text-muted-foreground`
- Collapse icon: `<ChevronDown size={16}>` rotated `-rotate-90` when closed
- Persistence: `localStorage` key `ara-section-<id>`

### Toast

- `role="status" aria-live="polite"`, `absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-xs font-medium rounded-lg animate-in slide-in-from-top-2 shadow-card`
- Type-dependent surface: `bg-destructive text-destructive-foreground` (error) / `ink-panel` (info) / `bg-primary text-primary-foreground` (success, default)
- Includes a dismiss (`✕`) button; auto-dismiss timer still applies
- Slide in: `animate-in slide-in-from-top-2`

### Field log (deep-research progress)

Renamed conceptually from "research agent log panel"; renders only while a deep-research run is active for the workspace.

```
rounded-xl ink-panel shadow-card overflow-hidden animate-in fade-in motion-reduce:animate-none
```
- `ink-panel` is the one dark surface reserved for this panel (`--ink-panel`: deep blue-black, not pure black — even when the app theme is light)
- Header: `border-b border-white/10`, spinning `<Loader2 size={12} className="text-highlight" />`, step count, and a `Stop` button
- Log lines are no longer colour-coded by an `[ERROR]`/`[WARNING]`/`[SUCCESS]` tag: only the most recent of the last 3 lines is tinted (`text-highlight`, the amber token); older lines are `opacity-45`

### Citation chips

- `inline-flex items-center justify-center px-1.5 mx-0.5 text-[10px] font-mono font-bold rounded bg-primary/10 text-primary border border-primary/30 cursor-pointer hover:bg-primary/20 transition-colors no-underline align-super`
- Renders as numbered superscripts: `[1]`, `[2]`…, keyboard-focusable `<button>`s (not `<span>`s), with a focus ring
- Behaviour: each chip is an inline anchor `#cite:<anchor>` that resolves via the chunk store and jumps straight to the exact saved source chunk (`onOpenDocument`) — not the external URL. If the source doc was deleted, it falls back to opening the original `docUrl`.

### Citation highlight (DocumentView)

- `rounded-lg border border-primary/50 bg-primary/5 shadow-card p-3` — a full highlighted card, not a left-border strip
- Label lives inside the card, not floating: `text-xs font-medium text-primary mb-2 pb-1.5 border-b-2 border-primary/20`, reading `[CITED]` (or `[CITED] Position not found — doc may have changed` if the chunk couldn't be relocated in the doc)

### Status badge / dot

- Container: `inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground` (connected) or `rounded-full border border-muted ... text-muted-foreground` (not connected) — pill-shaped, sentence case, not uppercase
- Leading dot: `w-1.5 h-1.5 rounded-full bg-background mr-1.5` (round, not square)

### Toggle switch (Settings)

- Track: `h-5 w-9 rounded-full` + `bg-primary` (on) / `bg-border` (off) — no border
- Thumb: `h-4 w-4 rounded-full bg-background shadow-sm`, positioned with `translate-x-[18px]` (on) / `translate-x-0.5` (off), not absolute `left`/`right` offsets

### Input / Select

- The base `Input`/`Select` primitives still default to `border-2 rounded-none` in their own source (same legacy "AGENT_WORKSPACE" comment as `Button`), but every actual usage overrides that via `className` — rendered inputs/selects are `rounded-lg` (or `rounded-md`) with a single-px border, `font-mono` reserved for value-is-data fields (URLs, model ids) rather than every input.
- Focus: `border-primary focus-visible:ring-2 focus-visible:ring-ring`
- Select content (as actually rendered, every call site): `border border-border rounded-lg shadow-card` — the base primitive's own default (`border-2 border-border rounded-none bg-popover shadow-md`) is never left un-overridden.

---

## Icons

All from `lucide-react`. Sizes: `size={12}` (micro), `size={14}` (default, e.g. `Send`), `size={16}` (section headers), `size={18}` (`StopCircle`).

Common icons in current use: `Edit2`, `Trash2`, `Sparkles`, `Send`, `StopCircle`, `ChevronDown`, `ChevronUp`, `ArrowLeft`, `ExternalLink`, `Download`, `Cloud`, `CloudDownload`, `Plus`, `Minus`, `Library`, `BookOpen`, `FileUp`, `FolderUp`, `FileText`, `Loader2`, `MessageSquare`, `Microscope`, `PanelRightClose`, `Paperclip`, `Search`, `SlidersHorizontal`, `Tag`, `User`, `Check`, `Copy`, `X`, `BookmarkPlus`. (`Image` was removed along with the image-import feature it belonged to.)

Empty-state emphasis now uses text/heading treatment (`.font-display text-lg`) rather than emoji glyphs; the earlier `📚` empty-source-list fallback is gone, and the no-favicon fallback renders a `<FileText>` icon chip, not a `📄` emoji.

---

## Motion

- All transitions: `transition-colors` (150ms, no easing override — Tailwind default ease-in-out)
- Field log: `animate-spin` on the `Loader2` icon
- Toast entry: `animate-in slide-in-from-top-2` (tw-animate-css)
- Slash-command / model-picker popovers: `animate-in fade-in slide-in-from-bottom-2`
- `@media (prefers-reduced-motion: reduce)`: now respected via Tailwind's `motion-reduce:animate-none` variant, applied alongside every `animate-pulse` / `animate-spin` / `animate-in` usage (field log, streaming caret, thinking indicator, popovers) — the earlier gap is closed.

---

## Z-index scale

Currently ad-hoc. Recommended semantic scale to adopt:

| Layer | Value | Use |
|---|---|---|
| base | 0 | Document flow |
| dropdown | 10 | Command autocomplete |
| sticky | 20 | Research running banner |
| modal-backdrop | 30 | (future) |
| modal | 40 | (future) |
| toast | 50 | `z-50` (current) |
| tooltip | 60 | (future) |

---

## Scrollbars

No longer hidden globally. The old `* { scrollbar-width: none }` rule was removed — it silently broke keyboard scrollability on overflow regions and failed WCAG 2.1 SC 1.4.13. Scrollbar hiding is now opt-in per element via the `.no-scrollbar` utility class (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`), applied only to specific overflow regions (e.g. popover lists) that still want the thumb hidden while keeping scroll/keyboard behaviour intact.

---

## Prose (markdown rendering)

Chat messages and document body use `@tailwindcss/typography`. Representative utilities from the actual `ChatView`/`DocumentView` renderers:

```
prose prose-sm dark:prose-invert max-w-none
prose-img:rounded-md prose-img:border prose-img:border-border
prose-headings:font-bold prose-a:text-primary prose-a:font-medium
prose-code:text-foreground
prose-pre:bg-muted/80 prose-pre:text-foreground prose-pre:rounded-md prose-pre:border prose-pre:border-border
```

Headings are no longer forced mono/uppercase — chat report headings additionally opt into `.prose-headings-display` (an `index.css` utility) for a display sans voice (`font-weight: 700`, tight tracking, `text-transform: none`), with the top-level `h2` carrying a thin bottom rule in the `--rule` violet token. `index.css` also tints list bullets/counters and task-list checkboxes with `--primary`, and draws a `--primary`-tinted inset stripe on the left edge of fenced code blocks — the `prose-pre` background/border/text overrides above exist specifically so code no longer renders as an unstyled black-on-nothing block in dark mode.

Math: KaTeX, triggered by `remark-math` + `rehype-katex`. LaTeX delimiters `\( \)` and `\[ \]` normalised to `$ $` / `$$ $$` before render.
