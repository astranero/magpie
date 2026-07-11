# Design System

## Theme

**Command post, dark-default.** The extension renders inside a 400px-wide browser side panel — a narrow instrument, not a canvas. The UI is always forced-dark (`class="dark"` on the root div), monochrome with a single white-on-black primary accent. The aesthetic is deliberate: monospace typography, hard square borders, offset drop-shadows, and ultra-compressed label type. Every surface signals rigour and precision. Warmth is carried by purposeful green (live research state), red (destructive / error), and the white primary — never by gradients or decoration.

---

## Color

All tokens use HSL via CSS custom properties consumed by Tailwind (`hsl(var(--token))`). The forced-dark theme is the only shipped theme; light-mode tokens exist in the stylesheet but are overridden at the root div.

### Active tokens (dark theme)

| Role | Token | Value | Hex approx |
|---|---|---|---|
| Background | `--background` | `hsl(0 0% 3.9%)` | `#0A0A0A` |
| Foreground / ink | `--foreground` | `hsl(0 0% 98%)` | `#FAFAFA` |
| Card surface | `--card` | same as background | `#0A0A0A` |
| Muted surface | `--muted` | `hsl(0 0% 14.9%)` | `#262626` |
| Muted text | `--muted-foreground` | `hsl(0 0% 63.9%)` | `#A3A3A3` |
| Primary (action / accent) | `--primary` | `hsl(0 0% 98%)` | `#FAFAFA` |
| Primary foreground | `--primary-foreground` | `hsl(0 0% 9%)` | `#171717` |
| Border | `--border` | `hsl(0 0% 14.9%)` | `#262626` |
| Input border | `--input` | same as border | `#262626` |
| Ring (focus) | `--ring` | `hsl(0 0% 83.1%)` | `#D4D4D4` |
| Destructive | `--destructive` | `hsl(0 62.8% 30.6%)` | `#7F1D1D` |

### Semantic state colours (direct Tailwind / inline)

| State | Class / value | Notes |
|---|---|---|
| Research running | `text-green-400` `border-green-900` `bg-black` | Agent log terminal panel |
| Error log line | `text-red-400` | Within research log |
| Warning log line | `text-yellow-400` | Within research log |
| Success log line | `text-blue-400` | Within research log |
| Destructive action | `text-destructive hover:bg-destructive` | Delete / unlink buttons |

### Color strategy: Restrained

Monochrome surface with white as the sole accent. Color enters only for semantic state (green = live, red = error/destructive). No decorative color.

---

## Typography

Single family throughout. No pairing.

| Role | Spec |
|---|---|
| Font family | `Geist Variable` (variable font, imported via `@fontsource-variable/geist`) |
| Font stack | `'Geist Variable', sans-serif` |
| UI chrome labels | `font-mono font-bold uppercase tracking-widest` at `text-[10px]` or `text-[9px]` |
| Section titles | `font-bold font-mono tracking-widest uppercase text-sm` |
| Button text | `font-bold font-mono uppercase tracking-widest` |
| Body / chat prose | `text-sm`, `prose prose-sm dark:prose-invert` via `@tailwindcss/typography` |
| Micro meta | `text-[10px]` or `text-[9px]` for timestamps, word counts, source counts |
| Code / math | KaTeX (`katex/dist/katex.min.css`) for LaTeX in chat; inline `<code>` in prose |

**Type scale is fixed, not fluid.** This is a narrow-panel tool; clamp-based fluid sizing would behave incorrectly at the 400px panel width.

---

## Shape & Border

- `--radius: 0rem` — **zero border-radius everywhere, no exceptions.** Applied to all shadcn primitives via the Tailwind config.
- `border-2` is the standard border weight. `border` (1px) used only for doc-card rows (inconsistency to resolve).
- `border-border` default; `border-primary` on focus / active states; `border-destructive/20` on destructive hover targets.

---

## Elevation & Shadow

One shadow style used consistently across cards, toasts, and popover surfaces:

```
shadow-[4px_4px_0_0_var(--tw-shadow-color)]
```

Shadow colour is always `shadow-primary/10` or `shadow-primary/20` — a very subtle white glow offset at exactly 4 × 4 px. No soft blurs, no layered shadows.

---

## Spacing & Layout

- Panel width: fixed 400px (Chrome side panel constraint)
- Panel height: `h-screen`, `overflow-hidden` on root
- Internal layout: `flex flex-col` shell; header + `flex-1 overflow-hidden` main + fixed bottom nav
- Section padding: `px-4 py-3` (header), `p-4` (content areas), `p-3` (chat input)
- Density is high — the panel is narrow. Use `gap-2` / `gap-3` between elements, `space-y-1` inside lists.
- No scrollbars rendered anywhere (`scrollbar-width: none` globally). Overflow handled with `overflow-y-auto no-scrollbar`.

---

## Components

### Shell structure

```
<div class="dark h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
  <header>          <!-- workspace selector, rename, delete -->
  <main class="flex-1 flex flex-col overflow-hidden">
    <!-- toast (absolute, centered top) -->
    <!-- research running banner (conditional) -->
    <!-- view content: Sources | Chat | Document | Settings -->
  </main>
  <nav>             <!-- Sources | Chat | Config tab bar -->
</div>
```

### Header / workspace selector

- `flex items-center px-4 py-3 bg-muted/20 border-b-2 border-border gap-3`
- Label: `text-xs font-mono font-bold text-muted-foreground uppercase tracking-widest`
- Select trigger: `h-8 border-none shadow-none bg-transparent font-bold font-mono uppercase tracking-wide`
- Rename button: `text-muted-foreground hover:text-primary p-2` + `<Edit2 size={14} />`
- Delete button: `text-muted-foreground hover:text-destructive p-2` + `<Trash2 size={14} />` (shown only when ≥2 workspaces)

### Bottom navigation

- Three tabs, equal width: `flex-1 text-center py-2 text-xs font-bold font-mono tracking-widest uppercase`
- Active: `border-2 border-primary bg-primary text-primary-foreground`
- Inactive: `border-2 border-transparent text-muted-foreground hover:border-muted hover:text-foreground`
- Separators: `w-px h-4 bg-border mx-2`

### Buttons (shadcn Button, `rounded-none border-2`)

| Variant | Style |
|---|---|
| default | `bg-primary text-primary-foreground border-primary hover:bg-primary/80` |
| outline | `border-border bg-background hover:bg-muted` |
| ghost | `border-transparent hover:bg-muted` |
| destructive | `bg-destructive/10 text-destructive border-destructive/40 hover:bg-destructive hover:text-destructive-foreground` |

All buttons: `rounded-none`, `transition-colors`, `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1`.

### Cards / document rows

- `group flex flex-col gap-3 p-3 border border-border bg-card hover:border-primary/50 transition-colors`
- Action row: `opacity-0 group-hover:opacity-100 transition-opacity` (hover-reveal pattern)
- Note: `border` not `border-2` here — intentional density difference for list rows.

### Section / collapsible

- Outer: `border-2 border-border bg-card shadow-[4px_4px_0_0_...] shadow-primary/10`
- Header trigger: `p-4 border-b-2 border-border bg-muted/20 hover:bg-muted/40 transition-colors`
- Title: `font-bold font-mono tracking-widest uppercase text-sm`
- Collapse icon: `<ChevronDown size={16}>` rotated `-rotate-90` when closed
- Persistence: `localStorage` key `ara-section-<id>`

### Toast

- `absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-primary text-primary-foreground text-xs font-bold uppercase tracking-widest border-2 border-primary shadow-[4px_4px_0_0_...] shadow-primary/20`
- Auto-dismiss: 4 seconds
- Slide in: `animate-in slide-in-from-top-2`

### Research agent log panel

```
bg-black border-2 border-border text-green-400 p-4 font-mono text-xs
```
- Header: `border-b-2 border-green-900`, icon `<Sparkles size={14} className="animate-pulse" />`
- Log lines coloured by tag: `[ERROR]` → `text-red-400`, `[WARNING]` → `text-yellow-400`, `[SUCCESS]` → `text-blue-400`, default → `opacity-80`

### Citation chips

- `inline-flex items-center justify-center px-1.5 mx-0.5 text-[10px] font-mono font-bold bg-primary/10 text-primary border-2 border-primary/30 cursor-pointer hover:bg-primary/20 transition-colors align-super`
- Renders as numbered superscripts: `[1]`, `[2]`…

### Citation highlight (DocumentView)

- `border-l-4 border-primary bg-primary/10 pl-4 py-2` — the only permitted left-border usage (it is a genuine directional indicator, not decoration)
- Floating label: `text-[9px] font-mono font-bold uppercase tracking-widest text-primary bg-primary/10 px-2 py-0.5 border-2 border-primary/30`

### Status badge / dot

- Container: `inline-flex items-center border-2 px-2.5 py-0.5 text-[10px] uppercase tracking-widest font-bold bg-primary text-primary-foreground`
- Leading dot: `w-1.5 h-1.5 bg-background mr-1.5` (square, not rounded)

### Toggle switch (Settings)

- Track: `w-12 h-6 border-2` + `bg-primary` (on) / `bg-muted` (off)
- Thumb: `w-4 h-4 bg-background absolute transition-all`; `right-0.5` (on), `left-0.5` (off)

### Input / Select

- All: `border-2 rounded-none font-mono`
- Focus: `border-primary focus-visible:ring-2 focus-visible:ring-ring`
- Select content: `border-2 border-border rounded-none bg-popover shadow-md`

---

## Icons

All from `lucide-react`. Sizes: `size={12}` (micro), `size={14}` (default), `size={16}` (section headers), `size={18}` (send/stop).

Common icons: `Edit2`, `Trash2`, `Sparkles`, `Send`, `StopCircle`, `ChevronDown`, `ArrowLeft`, `ExternalLink`, `Download`, `Cloud`, `CloudDownload`, `Plus`, `Minus`, `Library`, `BookOpen`, `FileUp`, `FolderUp`, `FileText`, `Image`.

Emoji fallbacks for empty states: `📚` (empty source list), `📄` (no favicon).

---

## Motion

- All transitions: `transition-colors` (150ms, no easing override — Tailwind default ease-in-out)
- Research log: `animate-pulse` on Sparkles icon
- Toast entry: `animate-in slide-in-from-top-2` (tw-animate-css)
- Command palette: `animate-in fade-in slide-in-from-bottom-2`
- `@media (prefers-reduced-motion: reduce)`: no explicit rule yet — **gap to address**

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

Hidden globally: `scrollbar-width: none` on `*`, `::-webkit-scrollbar { display: none }`. Scroll still works; the thumb is invisible. This is intentional to preserve the terminal aesthetic.

---

## Prose (markdown rendering)

Chat messages and document body use `@tailwindcss/typography`:

```
prose prose-sm dark:prose-invert max-w-none
prose-img:rounded-none prose-img:border-2 prose-img:border-border
prose-headings:font-bold prose-headings:font-mono prose-headings:uppercase prose-headings:tracking-wide
prose-a:text-primary
prose-pre:rounded-none prose-pre:border-2 prose-pre:border-border
```

Math: KaTeX, triggered by `remark-math` + `rehype-katex`. LaTeX delimiters `\( \)` and `\[ \]` normalised to `$ $` / `$$ $$` before render.
