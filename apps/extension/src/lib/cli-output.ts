// ─────────────────────────────────────────────
// Local-CLI chat route — pure helpers (unit-tested)
// ─────────────────────────────────────────────
// The "route chat through a local CLI" path shells out to the user's own
// `claude` / `agy` / `copilot` binary via the companion server. That binary is
// an interactive dev tool, not an API: it writes warnings to stderr, prints
// login prompts to stdout, and colors output with ANSI escapes. These helpers
// turn that raw terminal output into something safe to render as a chat
// answer — or detect that it isn't one at all.

/** ANSI escape sequences (colors, cursor movement, OSC titles) — never render
 *  these. Anchored on the ESC byte so bracketed prose ("[2026]") is untouched. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/g;

/**
 * Noise lines a CLI emits around its actual answer. Matched per-line so a real
 * answer that merely *mentions* stdin is untouched.
 */
const NOISE_LINE_RE = [
  /^Warning: no stdin data received in \d+s?, proceeding without it\b.*$/i,
  /^If piping from a slow command, redirect stdin explicitly.*$/i,
  /^\s*⏺?\s*Compacting conversation.*$/i,
  /^\s*Tip: .*$/i,
];

/** Strip terminal noise (ANSI codes, stdin warnings, tips) from CLI output. */
export function sanitizeCliOutput(raw: string): string {
  const noAnsi = (raw || '').replace(ANSI_RE, '');
  const lines = noAnsi.split('\n').filter(line => {
    const l = line.trim();
    return !NOISE_LINE_RE.some(re => re.test(l));
  });
  // The stdin warning is sometimes glued onto the END of the answer's last
  // line (stderr flushed mid-line). Cut it out of mixed lines too.
  return lines
    .join('\n')
    .replace(/\s*Warning: no stdin data received in \d+s?, proceeding without it\.?[^\n]*/gi, '')
    .trim();
}

/**
 * Output that is a CLI error state, not an answer (logged-out CLI, usage/help
 * text). Rendering these as the assistant's reply is worse than falling back
 * to the standard provider.
 */
export function isCliErrorOutput(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  // Auth/billing failures are TERSE one-liners; a long output that merely
  // mentions these phrases ("why do I get an invalid API key error?" answered
  // at length) is a real answer — length-gate so it isn't thrown away.
  if (t.length < 300 && /not logged in|please run \/login|\/login to (continue|authenticate)|invalid api key|credit balance is too low/i.test(t)) return true;
  // Usage/help dump means the command line was malformed, not answered.
  if (/^usage:\s/i.test(t)) return true;
  return false;
}

/**
 * Fold the chat turn's full context (system prompt + prior turns) into ONE
 * prompt for a single-shot CLI call. The CLI route previously sent only the
 * raw user message — dropping retrieval, page context, and history on the
 * floor — which is why CLI-mode answers ignored the user's sources.
 */
export function composeCliPrompt(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userPrompt: string,
): string {
  const parts: string[] = [];
  if (systemPrompt.trim()) {
    parts.push(`SYSTEM INSTRUCTIONS (follow these for this reply):\n${systemPrompt.trim()}`);
  }
  if (history.length) {
    const transcript = history
      .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n\n');
    parts.push(`CONVERSATION SO FAR:\n${transcript}`);
  }
  parts.push(`USER MESSAGE (reply to this, in the user's language):\n${userPrompt}`);
  return parts.join('\n\n---\n\n');
}
