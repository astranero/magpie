import React from 'react';

// ─────────────────────────────────────────────
// The magpie crossing the sky
// ─────────────────────────────────────────────
// Shown only while research is running, and only under a scene palette — the
// bird needs sky behind it, and `.dark` / plain light have none.
//
// Three rules it obeys, because a decoration that breaks any of them stops
// being charming very quickly:
//
//   1. `prefers-reduced-motion` freezes it. Not hidden — a still silhouette
//      keeps the composition while removing the movement, which is what the
//      setting actually asks for.
//   2. `pointer-events: none` throughout. It drifts across a live panel; it
//      must never eat a click meant for the text underneath.
//   3. `aria-hidden`, and no text. A screen reader already gets the phase and
//      elapsed time from the status line; a bird would be noise.
//
// CSS animation, not JS: the compositor runs transform/opacity off the main
// thread, so this costs nothing while a 449-document sync or a streaming
// response is saturating it.

/** One bird: body, head, and two wings that beat around a shared pivot. */
const Bird: React.FC<{ scale?: number }> = ({ scale = 1 }) => (
  <svg viewBox="0 0 40 24" width={40 * scale} height={24 * scale} fill="none" aria-hidden="true">
    {/* Far wing — drawn first so it sits behind the body, and offset in the
        beat so the two wings never look like one flat shape.
        Slender crescents, not filled triangles: at this size a broad wing
        merges with the body into one dark blob and the bird stops reading as
        a bird. The gap between the leading and trailing curve is the shape. */}
    <path className="magpie-wing magpie-wing-far" d="M20 12.4 C15.5 9, 10 5.6, 4.5 5 C9 8.6, 14 11.4, 19.6 13.2 Z" />
    {/* Body and long tail: the magpie's one identifying silhouette feature. */}
    <path className="magpie-body" d="M20 12 C24 10.6, 28 11.1, 31 12.5 L39 15 L30 15.4 C26 15.7, 22 14.4, 20 13 Z" />
    <circle className="magpie-body" cx="20.4" cy="11.6" r="2.4" />
    {/* Near wing */}
    <path className="magpie-wing magpie-wing-near" d="M20.6 12 C16.6 8.2, 11.4 4.6, 5.6 3.8 C10.4 7.8, 15.4 10.8, 20.4 12.9 Z" />
  </svg>
);

/**
 * A small flock drifting across the panel.
 *
 * Each bird gets its own duration, delay, drift height and scale, so they
 * never form a rigid line — the thing that makes a loop read as a loop.
 */
export const FlyingMagpie: React.FC<{ className?: string }> = ({ className }) => (
  <div
    className={`magpie-sky pointer-events-none absolute inset-0 overflow-hidden ${className || ''}`}
    aria-hidden="true"
  >
    <span className="magpie-flier" style={{ '--fly-dur': '13s', '--fly-delay': '0s',   '--fly-top': '16%', '--fly-rise': '-14px' } as React.CSSProperties}>
      <Bird scale={0.9} />
    </span>
    <span className="magpie-flier" style={{ '--fly-dur': '17s', '--fly-delay': '-7s',  '--fly-top': '44%', '--fly-rise': '10px'  } as React.CSSProperties}>
      <Bird scale={0.55} />
    </span>
    <span className="magpie-flier" style={{ '--fly-dur': '23s', '--fly-delay': '-15s', '--fly-top': '6%', '--fly-rise': '-6px'  } as React.CSSProperties}>
      <Bird scale={0.38} />
    </span>
  </div>
);
