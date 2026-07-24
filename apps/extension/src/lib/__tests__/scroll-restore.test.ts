import { describe, it, expect } from 'vitest';
import { shouldRestoreScroll, BOTTOM_PIN_SLACK_PX } from '../scroll-restore';

// Clicking a citation chip hides the chat panel (display:none resets scrollTop),
// so the reader's place must be saved and restored explicitly. These pin WHEN
// we restore vs jump to the newest message.

const box = (scrollHeight: number, clientHeight: number) => ({ scrollHeight, clientHeight });

describe('shouldRestoreScroll', () => {
  it('restores when the reader was scrolled up in a long transcript', () => {
    // 4000px of content, 600px viewport, they were at 1200 — mid-conversation.
    expect(shouldRestoreScroll(1200, box(4000, 600))).toBe(true);
  });

  it('does NOT restore when they were pinned to the bottom — jump to latest', () => {
    const maxScroll = 4000 - 600;              // 3400
    expect(shouldRestoreScroll(maxScroll, box(4000, 600))).toBe(false);
    // Within the slack band still counts as pinned.
    expect(shouldRestoreScroll(maxScroll - (BOTTOM_PIN_SLACK_PX - 10), box(4000, 600))).toBe(false);
  });

  it('restores just outside the slack band', () => {
    const maxScroll = 4000 - 600;
    expect(shouldRestoreScroll(maxScroll - (BOTTOM_PIN_SLACK_PX + 10), box(4000, 600))).toBe(true);
  });

  it('does not restore a top/never-scrolled position', () => {
    expect(shouldRestoreScroll(0, box(4000, 600))).toBe(false);
    expect(shouldRestoreScroll(null, box(4000, 600))).toBe(false);
    expect(shouldRestoreScroll(undefined, box(4000, 600))).toBe(false);
  });

  it('does not restore when the content fits the viewport', () => {
    expect(shouldRestoreScroll(50, box(500, 600))).toBe(false);
  });

  it('trusts the saved offset when the box is not laid out yet', () => {
    // A hidden element reports 0/0; discarding the offset there would lose the
    // position in exactly the case this feature exists for.
    expect(shouldRestoreScroll(1200, box(0, 0))).toBe(true);
  });

  it('handles a missing box', () => {
    expect(shouldRestoreScroll(1200, null)).toBe(false);
  });
});
