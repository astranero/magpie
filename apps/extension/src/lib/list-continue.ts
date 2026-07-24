// ─────────────────────────────────────────────
// Markdown list auto-continue in the composer
// ─────────────────────────────────────────────
// When the caret sits inside a list item, the next Enter should continue the
// list rather than send — the behaviour every markdown editor has. This is the
// pure core of it, shared by the plain-Enter and Shift+Enter handlers so the
// two can never drift.
//
// Two cases, matching what a writer expects:
//   - a NON-EMPTY item ("1. one") → start the next item ("2. "), numbers
//     incremented, bullets copied, indentation preserved;
//   - an EMPTY item ("1. " with nothing after the marker) → END the list,
//     stripping the marker back to a blank line. A second Enter then sends.
//
// Returns null when the caret is not in a list line, so the caller falls
// through to its normal Enter (send) or Shift+Enter (newline) behaviour.

/** A list line: optional indent, a `-`/`*`/`+` bullet or `N.` number, one space, then the item text. */
const LIST_LINE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

export interface ContinueResult {
  /** The full textarea value after the edit. */
  value: string;
  /** Where the caret should land. */
  caret: number;
}

/**
 * Continue or end the list the caret is in.
 *
 * @param value the whole textarea value
 * @param caret the caret position (selectionStart)
 * @returns the edited value+caret, or null when not in a list line
 */
export function continueList(value: string, caret: number): ContinueResult | null {
  const pos = Math.max(0, Math.min(caret, value.length));
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const line = value.slice(lineStart, pos);
  const m = LIST_LINE.exec(line);
  if (!m) return null;

  const [, indent, marker, content] = m;

  // Empty item → end the list: drop the marker on this line, plain newline.
  if (content.trim() === '') {
    return {
      value: value.slice(0, lineStart) + value.slice(pos),
      caret: lineStart,
    };
  }

  // Non-empty item → open the next one. Numbers advance; bullets repeat.
  const nextMarker = /^\d+\.$/.test(marker) ? `${parseInt(marker, 10) + 1}.` : marker;
  const insert = `\n${indent}${nextMarker} `;
  return {
    value: value.slice(0, pos) + insert + value.slice(pos),
    caret: pos + insert.length,
  };
}
