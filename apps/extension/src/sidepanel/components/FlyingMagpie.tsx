import React from 'react';

// ─────────────────────────────────────────────
// The little magpie that flaps while it thinks
// ─────────────────────────────────────────────
// A small side-profile bird — round head, teardrop body, the magpie's long
// upswept tail, a short beak, an eye — sitting at the LEFT of the thinking
// status and flapping its wings. Small on purpose: it is a companion to the
// text, not a banner. (The earlier version drifted a flock across a sky band,
// which read as a header and barely as a bird — replaced by this.)
//
// Only the wing transforms animate, so the compositor runs it off the main
// thread — free even while a stream or a 449-doc sync saturates it.
// `prefers-reduced-motion` folds the wing to rest instead of hiding the bird.

export const FlyingMagpie: React.FC<{ size?: number; className?: string }> = ({ size = 22, className }) => (
  <span
    className={`magpie-thinker inline-block shrink-0 ${className || ''}`}
    style={{ width: size, height: size }}
    aria-hidden="true"
  >
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none">
      {/* Tail — long and upswept, the magpie's tell. */}
      <path className="magpie-body" d="M13 19 C9 20, 4 22, 1.5 25 C5 24.5, 9 23.5, 13.5 22 Z" />
      {/* Body — a teardrop leaning forward. */}
      <path className="magpie-body" d="M10 18.5 C10 14, 13.5 11, 18 11.5 C22 12, 24.5 15, 23.5 18.5 C22.5 21.5, 19 23, 15.5 22.5 C12.5 22, 10.4 20.5, 10 18.5 Z" />
      {/* Head + short beak. */}
      <circle className="magpie-body" cx="22.5" cy="12" r="3.4" />
      <path className="magpie-body" d="M25.4 10.8 L29 9.6 L25.8 12.6 Z" />
      {/* Eye — background-coloured dot in the head. */}
      <circle cx="23.2" cy="11.4" r="0.85" fill="hsl(var(--background))" />
      {/* Legs, tiny. */}
      <line x1="15" y1="22.4" x2="15" y2="25" className="stroke-current magpie-leg" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="18" y1="22.6" x2="18.4" y2="25" className="stroke-current magpie-leg" strokeWidth="0.9" strokeLinecap="round" />
      {/* Wing — the only moving part, pivoting at the shoulder. */}
      <path className="magpie-wing magpie-flap" d="M15 16 C17 12.5, 20 11, 22.5 11.5 C21 14, 18.5 16, 15.5 17 Z" />
    </svg>
  </span>
);
