// ─────────────────────────────────────────────
// Provider auto-detection — kill the onboarding friction
// ─────────────────────────────────────────────
// "Install extension + paste an API key" filters out most humans. Detect what
// the machine already has and offer it in one click:
//   1. BYOK OpenAI-compatible endpoint — ALWAYS PREFERRED when configured;
//      detection never overrides a user-set endpoint/key.
//   2. Ollama on localhost:11434 — fully local, OpenAI-compatible /v1, rides
//      the existing client path unchanged.
//   3. Chrome built-in Gemini (Prompt API / Gemini Nano) — zero-install,
//      on-device; needs its own client branch (not OpenAI-compatible).
// Detection runs in extension contexts (panel/SW) — plain fetch + global probe.

export interface DetectedProviders {
  ollama: { available: boolean; models: string[] };
  builtinGemini: { available: boolean; status: string };
}

export const OLLAMA_BASE_URL = 'http://localhost:11434';
export const OLLAMA_OPENAI_URL = `${OLLAMA_BASE_URL}/v1`;
/** Sentinel stored in customUrl to select the built-in Gemini client branch. */
export const BUILTIN_GEMINI_SENTINEL = 'chrome://builtin-gemini';

/** Is Ollama serving locally? Returns installed model names (may be []). */
export async function detectOllama(timeoutMs = 1200): Promise<{ available: boolean; models: string[] }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json().catch(() => null);
    const models = Array.isArray(data?.models)
      ? data.models.map((m: any) => String(m?.name || '')).filter(Boolean)
      : [];
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

/**
 * Chrome built-in Gemini (Prompt API). `LanguageModel` is the stable global
 * (Chrome 138+); availability() reports 'available' | 'downloadable' |
 * 'downloading' | 'unavailable'. We treat downloadable as available — the
 * first create() triggers the one-time model download.
 */
export async function detectBuiltinGemini(): Promise<{ available: boolean; status: string }> {
  try {
    const LM: any = (globalThis as any).LanguageModel;
    if (!LM?.availability) return { available: false, status: 'unsupported' };
    const status = String(await LM.availability());
    return { available: status === 'available' || status === 'downloadable' || status === 'downloading', status };
  } catch {
    return { available: false, status: 'error' };
  }
}

export async function detectProviders(): Promise<DetectedProviders> {
  const [ollama, builtinGemini] = await Promise.all([detectOllama(), detectBuiltinGemini()]);
  return { ollama, builtinGemini };
}

/** Pick a sensible default chat model from an Ollama tag list. */
export function pickOllamaModel(models: string[]): string {
  // Prefer general instruct models over embed/vision-only tags.
  const chatty = models.filter(m => !/embed|bge|minilm|nomic|all-minilm/i.test(m));
  const preferred = chatty.find(m => /llama|qwen|mistral|gemma|phi|deepseek/i.test(m));
  return preferred || chatty[0] || models[0] || '';
}

/**
 * Zero-config first run: if the user has configured NOTHING, adopt the best
 * detected provider so the first chat just works. BYOK preference is absolute:
 * any existing customUrl or customKey means we change nothing.
 * Returns what was configured, or null if untouched/none found.
 */
export async function autoConfigureProvider(): Promise<'ollama' | 'builtin-gemini' | null> {
  try {
    const s = await chrome.storage.local.get(['customUrl', 'customKey', 'providerAutoConfigured']);
    if (s.customUrl || s.customKey) return null;          // user has a setup — never touch it
    if (s.providerAutoConfigured === 'declined') return null; // user cleared a previous auto-config

    const ollama = await detectOllama();
    if (ollama.available && ollama.models.length > 0) {
      await chrome.storage.local.set({
        customUrl: OLLAMA_OPENAI_URL,
        customModel: pickOllamaModel(ollama.models),
        providerAutoConfigured: 'ollama',
      });
      return 'ollama';
    }
    const builtin = await detectBuiltinGemini();
    if (builtin.available) {
      await chrome.storage.local.set({
        customUrl: BUILTIN_GEMINI_SENTINEL,
        customModel: 'gemini-nano',
        providerAutoConfigured: 'builtin-gemini',
      });
      return 'builtin-gemini';
    }
    return null;
  } catch {
    return null;
  }
}
