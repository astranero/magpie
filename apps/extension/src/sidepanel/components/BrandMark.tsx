import React from 'react';

// ─────────────────────────────────────────────
// Magpie brand mark
// ─────────────────────────────────────────────
// A magpie perched on an index card. The bird is one ink-colored path
// (currentColor, so it follows the theme); the card carries the catalog
// red rule — the one brand accent, same as section headers. The magpie's
// identifying feature is its long upswept tail, so the silhouette spends
// its detail there and nowhere else.

interface MarkProps {
  size?: number;
  className?: string;
}

export const MagpieMark: React.FC<MarkProps> = ({ size = 18, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    {/* Index card */}
    <rect x="2" y="16.5" width="20" height="6" rx="1" className="stroke-current opacity-40" strokeWidth="1.4" />
    {/* Catalog red rule on the card */}
    <line x1="4.5" y1="19" x2="19.5" y2="19" stroke="hsl(var(--rule))" strokeWidth="1.4" strokeLinecap="round" />
    {/* Magpie: round head, teardrop body, long upswept tail */}
    <path
      d="M6.2 10.2
         C6.2 8.9 7.2 7.9 8.4 7.9
         C9.3 7.9 10 8.4 10.4 9.1
         L13 10.4
         L21.2 4.6
         C21.6 4.4 21.9 4.8 21.7 5.1
         L14.6 12.2
         C14.2 14 12.7 15.2 10.9 15.2
         C8.8 15.2 7.1 13.7 6.9 11.7
         L4.6 10.9
         C4.3 10.8 4.3 10.4 4.6 10.3
         Z"
      className="fill-current"
    />
    {/* Legs */}
    <line x1="9.7" y1="15.2" x2="9.7" y2="16.5" className="stroke-current" strokeWidth="1.2" strokeLinecap="round" />
    <line x1="12" y1="14.9" x2="12.3" y2="16.5" className="stroke-current" strokeWidth="1.2" strokeLinecap="round" />
    {/* Eye — paper-colored dot inside the ink head */}
    <circle cx="8.2" cy="9.6" r="0.7" fill="hsl(var(--background))" />
  </svg>
);

/**
 * Larger illustrated variant for empty states: the magpie on its card with
 * ruled "text" lines — a card waiting to be filled. Muted by default so it
 * invites rather than shouts.
 */
export const MagpieEmptyIllustration: React.FC<MarkProps> = ({ size = 72, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    {/* Card */}
    <rect x="4" y="27" width="40" height="16" rx="2" className="stroke-current opacity-50" strokeWidth="1.6" />
    <line x1="8" y1="32" x2="40" y2="32" stroke="hsl(var(--rule) / 0.8)" strokeWidth="1.6" strokeLinecap="round" />
    {/* Empty ruled lines — knowledge not yet written */}
    <line x1="8" y1="36.5" x2="34" y2="36.5" className="stroke-current opacity-30" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="8" y1="40" x2="26" y2="40" className="stroke-current opacity-30" strokeWidth="1.4" strokeLinecap="round" />
    {/* Magpie, same silhouette scaled */}
    <path
      d="M12.4 16.4
         C12.4 13.8 14.4 11.8 16.8 11.8
         C18.6 11.8 20 12.8 20.8 14.2
         L26 16.8
         L42.4 5.2
         C43.2 4.8 43.8 5.6 43.4 6.2
         L29.2 20.4
         C28.4 24 25.4 26.4 21.8 26.4
         C17.6 26.4 14.2 23.4 13.8 19.4
         L9.2 17.8
         C8.6 17.6 8.6 16.8 9.2 16.6
         Z"
      className="fill-current"
    />
    <line x1="19.4" y1="26.4" x2="19.4" y2="29" className="stroke-current" strokeWidth="1.6" strokeLinecap="round" />
    <line x1="24" y1="25.8" x2="24.6" y2="29" className="stroke-current" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="16.4" cy="15.2" r="1.3" fill="hsl(var(--background))" />
  </svg>
);
