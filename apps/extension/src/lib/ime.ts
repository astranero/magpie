// ─────────────────────────────────────────────
// Input-method editors — when Enter is not "send"
// ─────────────────────────────────────────────
// Typing Chinese, Japanese or Korean goes through an IME: you type Latin
// letters, a candidate list appears, and ENTER CONFIRMS THE CANDIDATE. A chat
// box that treats every Enter as "send" therefore fires mid-word — shipping a
// half-composed message and destroying the composition. It is the single most
// common way a Latin-tested chat UI breaks for CJK users, and it is invisible
// to anyone testing in English.
//
// Two signals, because neither is universal:
//   • `isComposing` — the standard, set between compositionstart and
//     compositionend.
//   • `keyCode === 229` — the legacy sentinel some browsers/IMEs still emit
//     ("processing key") instead of, or in addition to, setting isComposing.
//     Cheap to check and it costs nothing on real Enter presses, which never
//     carry 229.

/** Just enough of a key event to decide; keeps this testable without React. */
export interface ComposingKeyEvent {
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}

/**
 * True while an IME is mid-composition — the caller must ignore the key.
 *
 * Use it as the FIRST line of any Enter-to-submit handler, before the palette,
 * the list continuation, or the send. Guarding only the send branch still lets
 * the other branches steal the candidate-confirm keystroke.
 */
export function isImeComposing(e: ComposingKeyEvent | null | undefined): boolean {
  if (!e) return false;
  if (e.nativeEvent?.isComposing === true) return true;
  if (e.isComposing === true) return true;
  return e.keyCode === 229;
}
