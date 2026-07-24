// ─────────────────────────────────────────────
// Chat scroll restoration (pure)
// ─────────────────────────────────────────────
// Clicking a citation chip navigates away from the chat to the source
// document. The chat panel is hidden (display:none), which resets scrollTop to
// 0 — so the reader's position has to be saved and put back explicitly, or
// coming back dumps them at the bottom of a long transcript and they lose
// their place.
//
// The decision is pure so it can be tested without a DOM.

/** How close to the bottom still counts as "pinned to the latest message". */
export const BOTTOM_PIN_SLACK_PX = 80;

export interface ScrollBoxMetrics {
  scrollHeight: number;
  clientHeight: number;
}

/**
 * On becoming visible again, should we put the reader back where they were,
 * or jump to the newest message?
 *
 * Restore their exact position UNLESS they were already pinned to the bottom —
 * in that case jumping to the bottom is what they want, and it also handles
 * messages that arrived while they were away (the old offset would strand them
 * just above the new content).
 */
export function shouldRestoreScroll(
  savedScrollTop: number | null | undefined,
  box: ScrollBoxMetrics | null | undefined
): boolean {
  if (savedScrollTop == null || !box) return false;
  if (savedScrollTop <= 0) return false;                 // top, or never scrolled
  // Not laid out yet (hidden element reports 0) — nothing meaningful to compare
  // against, so trust the saved offset rather than discarding it.
  if (box.scrollHeight <= 0 || box.clientHeight <= 0) return true;
  const maxScroll = box.scrollHeight - box.clientHeight;
  if (maxScroll <= 0) return false;                      // content fits, no scroll
  return savedScrollTop < maxScroll - BOTTOM_PIN_SLACK_PX;
}
