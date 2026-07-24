// ─────────────────────────────────────────────
// Reasoning-model output — separating thought from answer
// ─────────────────────────────────────────────
// Reasoning models (DeepSeek-R1 and friends) emit a chain of thought before the
// answer. Providers expose it two different ways:
//
//   1. A SEPARATE SSE field — `delta.reasoning_content` (DeepSeek's own API) or
//      `delta.reasoning` (OpenRouter). Clean: the answer field stays pure.
//   2. INLINE in `delta.content`, wrapped in `<think>…</think>`. Common when a
//      local runtime (Ollama, llama.cpp, vLLM) serves an R1-family model through
//      an OpenAI-compatible shim.
//
// Case 1 is a one-line read in the SSE loop. Case 2 needs this module: the tags
// arrive split across chunk boundaries (`<thi` | `nk>`), so a stateless
// `String.replace` per chunk cannot work — it would leak half-tags into the
// answer and, worse, publish the model's private reasoning as if it were the
// reply.
//
// Why this matters at all: before the reasoning channel existed, the SSE parser
// read only `delta.content`, so an R1-class model produced NOTHING on screen for
// the entire thinking phase — 30-120s of dead air — and then dumped the answer
// at once. The model was never slow; the only visible channel was empty.

/** The longest opening/closing tag we recognise — how much tail we must hold. */
const MAX_TAG = '</think>'.length;

/** Tag pairs seen in the wild. Checked in order; the first opener wins. */
const TAG_PAIRS: Array<[open: string, close: string]> = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
];

export interface ThinkSplit {
  /** Text belonging to the answer — safe to show and to persist. */
  answer: string;
  /** Text belonging to the chain of thought — shown live, never persisted. */
  reasoning: string;
}

/**
 * Streaming-safe `<think>` splitter.
 *
 * Feed it every `content` delta in order; it returns the answer/reasoning parts
 * of THAT delta. State (inside-a-tag, and a held-back tail that might be the
 * start of one) lives in the splitter, so tags straddling chunk boundaries are
 * handled correctly.
 *
 * `flush()` must be called at end of stream to release any held tail — without
 * it, a reply ending in something like `5 < 8` would lose its last few
 * characters, because they were being held on the chance they were `<think>`.
 */
export function createThinkSplitter() {
  let inside = false;
  let closer = '';
  /** Text held back because it could still turn out to be a tag prefix. */
  let pending = '';

  /** Could `s` still grow into `tag`? (i.e. is it a proper prefix) */
  const isPrefix = (s: string, tag: string) => tag.startsWith(s) && s.length < tag.length;

  const couldBecomeTag = (s: string): boolean => {
    if (!s) return false;
    if (inside) return isPrefix(s, closer);
    return TAG_PAIRS.some(([open]) => isPrefix(s, open));
  };

  function push(delta: string): ThinkSplit {
    let answer = '';
    let reasoning = '';
    let buf = pending + delta;
    pending = '';

    while (buf) {
      if (!inside) {
        // Look for the earliest opener anywhere in the buffer.
        let at = -1;
        let pair: [string, string] | null = null;
        for (const p of TAG_PAIRS) {
          const i = buf.indexOf(p[0]);
          if (i !== -1 && (at === -1 || i < at)) { at = i; pair = p; }
        }
        if (at === -1) break;
        answer += buf.slice(0, at);
        buf = buf.slice(at + pair![0].length);
        inside = true;
        closer = pair![1];
      } else {
        const at = buf.indexOf(closer);
        if (at === -1) break;
        reasoning += buf.slice(0, at);
        buf = buf.slice(at + closer.length);
        inside = false;
        closer = '';
      }
    }

    // Whatever is left has no complete tag. Hold back only the tail that could
    // still BECOME one; emit the rest so text keeps flowing during a long
    // reasoning block rather than piling up until the closer arrives.
    let hold = 0;
    for (let n = Math.min(MAX_TAG, buf.length); n > 0; n--) {
      if (couldBecomeTag(buf.slice(buf.length - n))) { hold = n; break; }
    }
    if (hold) {
      pending = buf.slice(buf.length - hold);
      buf = buf.slice(0, buf.length - hold);
    }
    if (inside) reasoning += buf; else answer += buf;

    return { answer, reasoning };
  }

  /** Release the held tail at end of stream. Safe to call more than once. */
  function flush(): ThinkSplit {
    const rest = pending;
    pending = '';
    if (!rest) return { answer: '', reasoning: '' };
    return inside ? { answer: '', reasoning: rest } : { answer: rest, reasoning: '' };
  }

  return { push, flush, get isInsideThink() { return inside; } };
}

/**
 * The reasoning text carried by one SSE delta, whichever field the provider
 * uses. Returns '' when there is none — callers can treat that as "not a
 * reasoning model" and behave exactly as before.
 */
export function reasoningFromDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const d = delta as Record<string, unknown>;
  const v = d.reasoning_content ?? d.reasoning;
  return typeof v === 'string' ? v : '';
}

/**
 * Last non-empty line of a reasoning trace, clipped — what the status line
 * shows as a sign of life. Reasoning arrives as loose prose, so the tail is
 * the most recent thing the model was considering.
 */
export function reasoningTail(reasoning: string, maxChars = 120): string {
  const lines = reasoning.split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return last.length > maxChars ? '…' + last.slice(-(maxChars - 1)) : last;
}
