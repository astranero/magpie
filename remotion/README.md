# Magpie — Remotion demo

A ~72s animated motion-graphics walkthrough of the Magpie research-assistant
extension, built with [Remotion](https://remotion.dev). Pure React — no real
screen recording — so it renders deterministically anywhere.

## Scenes

`Hero → Capture → Deep research → Grounded chat → /teach → /flashcard → /data → Drive sync → Outro`

Each scene lives in `src/scenes/`; shared UI (logo, side-panel frame, bubbles,
chips, typewriter, captions) is in `src/components/ui.tsx`; the palette and scene
durations are in `src/theme.ts`.

## Run it

```bash
cd remotion
npm install
npm run dev        # open Remotion Studio to scrub/preview
```

## Render an MP4

```bash
npm run render     # → out/magpie-demo.mp4  (1920×1080, 30fps)
npm run still      # → out/poster.png       (a poster frame)
```

Rendering needs the Remotion headless renderer (Chromium) which
`@remotion/cli` downloads on first run.

## Tweak

- Length / pacing: edit `SCENES` in `src/theme.ts`.
- Colors / fonts: `COLORS`, `FONT_*` in `src/theme.ts`.
- Copy: the strings in each scene component.
