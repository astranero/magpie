// ─────────────────────────────────────────────
// LLM client — OpenAI-compatible provider (chat, streaming, models)
// ─────────────────────────────────────────────
// Extracted from service-worker.ts. Depends only on chrome.storage config +
// fetch — no DB, caches, or worker state. Guarded by e2e/chat.spec.ts.

import { BUILTIN_GEMINI_SENTINEL } from '../lib/provider-detect';
import { isAllowedProviderUrl } from '../lib/settings';

export async function getProviderSettings(): Promise<Record<string, string>> {
  const s = await chrome.storage.local.get(['customUrl', 'customKey', 'customModel', 'visionModel']);
  // Endpoint policy: https, or http only to loopback — a remote http:// URL
  // would carry the API key in cleartext. Invalid/empty → no endpoint (callers
  // surface their normal "configure Settings" error).
  const rawUrl = typeof s.customUrl === 'string' && isAllowedProviderUrl(s.customUrl) ? s.customUrl : '';
  // Built-in Gemini sentinel passes through untouched — it's a client branch,
  // not a URL (appending /chat/completions to it would corrupt the check).
  const endpoint = s.customUrl === BUILTIN_GEMINI_SENTINEL
    ? BUILTIN_GEMINI_SENTINEL
    : rawUrl ? (rawUrl.endsWith('/chat/completions') ? rawUrl : `${rawUrl.replace(/\/+$/, '')}/chat/completions`) : '';
  return {
    apiKey: s.customKey || '',
    endpoint,
    model: s.customModel || '',
    visionModel: s.visionModel || ''
  };
}

// ── Chrome built-in Gemini (Prompt API / Gemini Nano) ──────────────────────
// Zero-install on-device fallback for users with no key and no Ollama. NOT
// OpenAI-compatible, so it gets its own branch. Small context — long research
// prompts may exceed its quota; the error message steers users to BYOK, which
// is always the preferred path when configured.
async function builtinGeminiSession(systemPrompt: string): Promise<any> {
  const LM: any = (globalThis as any).LanguageModel;
  if (!LM?.create) throw new Error('Built-in Gemini is not available in this Chrome. Set an API endpoint in Settings.');
  return LM.create({
    // No `languages` constraint: declaring ['en'] pinned every answer to
    // English, so non-English users could never chat in their own language.
    expectedOutputs: [{ type: 'text' }],
    initialPrompts: [{ role: 'system', content: systemPrompt }]
  });
}

function builtinPrompt(history: any[], userPrompt: string): string {
  // Prompt API sessions take turns; fold history into one turn for simplicity.
  const past = history.map(h => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${typeof h.content === 'string' ? h.content : ''}`).join('\n');
  return past ? `${past}\nUser: ${userPrompt}` : userPrompt;
}

function builtinGeminiError(err: unknown): Error {
  const msg = String((err as any)?.message || err);
  if (/quota|too large|input.*long/i.test(msg)) {
    return new Error('Built-in Gemini ran out of context (it is a small on-device model). For research and long chats, set an API endpoint in Settings — your own key is always preferred.');
  }
  return new Error(`Built-in Gemini error: ${msg}`);
}

async function chatWithBuiltinGemini(systemPrompt: string, history: any[], userPrompt: string, signal?: AbortSignal, onDelta?: (d: string) => void): Promise<string> {
  let session: any = null;
  try {
    session = await builtinGeminiSession(systemPrompt);
    const prompt = builtinPrompt(history, userPrompt);
    if (onDelta) {
      let full = '';
      const stream = session.promptStreaming(prompt, { signal });
      // Newer Chrome yields deltas; older yields cumulative text. Handle both.
      let last = '';
      for await (const chunk of stream as AsyncIterable<string>) {
        const piece = chunk.startsWith(last) && last.length > 0 ? chunk.slice(last.length) : chunk;
        last = chunk.startsWith(last) ? chunk : last + chunk;
        full += piece;
        onDelta(piece);
      }
      return full;
    }
    return await session.prompt(prompt, { signal });
  } catch (err) {
    throw builtinGeminiError(err);
  } finally {
    try { session?.destroy?.(); } catch { /* session already gone */ }
  }
}

/**
 * Human-readable provider failure. Providers answer errors with a JSON blob
 * (often nested, e.g. OpenRouter's `error.metadata.raw` + retry hints) — the
 * raw dump used to be shown verbatim in the chat panel. Exported for tests.
 */
export function formatProviderError(status: number, body: string): string {
  let detail = (body || '').trim();
  let retryAfter: number | undefined;
  try {
    const parsed = JSON.parse(detail);
    const e = parsed?.error ?? parsed;
    const msg = typeof e?.message === 'string' ? e.message.trim() : '';
    const raw = typeof e?.metadata?.raw === 'string' ? e.metadata.raw.trim() : '';
    // Generic wrapper messages ("Provider returned error") hide the real cause
    // that lives in metadata.raw — prefer the specific one.
    detail = (raw && (!msg || /provider returned error|internal error|unknown/i.test(msg))) ? raw : (msg || raw || detail);
    const ra = e?.metadata?.retry_after_seconds ?? parsed?.retry_after_seconds;
    if (typeof ra === 'number' && ra > 0) retryAfter = ra;
  } catch { /* not JSON — keep the raw text */ }
  // Strip markdown-mangled URLs and cap length — this renders in a ~400px panel.
  detail = detail.replace(/\s+/g, ' ').slice(0, 280);
  const label =
    status === 401 ? 'Provider rejected the API key (401)' :
    status === 402 ? 'Provider needs credits (402)' :
    status === 429 ? 'Provider rate-limited the request (429)' :
    status >= 500 ? `Provider is having trouble (${status})` :
    `Provider error ${status}`;
  const retry = retryAfter ? ` Retry in ~${Math.ceil(retryAfter)}s.` : (status === 429 ? ' Wait a moment and retry, or add your own API key in Settings.' : '');
  return `${label}: ${detail}${retry}`;
}

export async function chatWithCustom(systemPrompt: string, history: any[], userPrompt: string, signal?: AbortSignal): Promise<string> {
  const { apiKey, endpoint, model } = await getProviderSettings();
  if (!endpoint) throw new Error('Custom endpoint missing.');
  if (endpoint === BUILTIN_GEMINI_SENTINEL) return chatWithBuiltinGemini(systemPrompt, history, userPrompt, signal);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(formatProviderError(res.status, errText));
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'No response from Custom provider.';
}

/**
 * Streaming variant of chatWithCustom. Requests `stream: true` and parses the
 * SSE response, invoking `onDelta` per content token. Falls back to a single
 * onDelta call if the provider replies with plain JSON (no SSE support).
 */
export async function chatWithCustomStream(
  systemPrompt: string,
  history: any[],
  userPrompt: string,
  signal: AbortSignal,
  onDeltaRaw: (delta: string) => void
): Promise<void> {
  // F1: coalesce SSE tokens to reduce IPC/render pressure.
  // Flush every ~40ms or when the buffer reaches ~128 chars, whichever comes
  // first. One postMessage per flush instead of one per token.
  const FLUSH_MS = 40;
  const FLUSH_CHARS = 128;
  let deltaBuf = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!deltaBuf) return;
    const chunk = deltaBuf;
    deltaBuf = '';
    onDeltaRaw(chunk);
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  };
  const onDelta = (delta: string) => {
    deltaBuf += delta;
    if (deltaBuf.length >= FLUSH_CHARS) flush();
    else scheduleFlush();
  };
  // Cancel path — clear the timer so we don't fire after abort.
  signal.addEventListener('abort', () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }, { once: true });

  const { apiKey, endpoint, model } = await getProviderSettings();
  if (!endpoint) throw new Error('Custom endpoint missing.');
  if (endpoint === BUILTIN_GEMINI_SENTINEL) {
    await chatWithBuiltinGemini(systemPrompt, history, userPrompt, signal, onDelta);
    flush();
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      stream: true
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(formatProviderError(res.status, errText));
  }

  const contentType = res.headers.get('content-type') || '';
  if (!res.body || !contentType.includes('event-stream')) {
    // Provider ignored stream:true — plain JSON response
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (text) onDeltaRaw(text); // single-shot: bypass coalescer
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { flush(); return; }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content
            ?? json.choices?.[0]?.message?.content
            ?? '';
          if (delta) onDelta(delta);
        } catch {
          // Incomplete JSON split across reads — rare since we split on
          // newlines, but skip rather than crash the stream.
        }
      }
    }
    // Stream ended without an explicit [DONE] — flush any remainder.
    flush();
  } catch (err) {
    flush(); // don't lose buffered content on error
    throw err;
  }
}

// ─────────────────────────────────────────────
// Tool-calling (OpenAI-compatible) — for the agentic page-context strategy
// ─────────────────────────────────────────────

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ToolCall { id: string; name: string; args: any }

function safeParseArgs(raw: unknown): any {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * One tool-calling round: send messages + tool schemas, return any tool calls
 * the model made plus its assistant message (to append verbatim to the running
 * transcript before the tool results). Model-agnostic OpenAI shape; providers
 * without tool support simply return no tool_calls, so the caller stops.
 */
export async function chatWithTools(
  messages: any[], tools: ToolDef[], signal?: AbortSignal,
): Promise<{ toolCalls: ToolCall[]; content: string; assistantMessage: any }> {
  const { apiKey, endpoint, model } = await getProviderSettings();
  if (!endpoint) throw new Error('Custom endpoint missing.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(formatProviderError(res.status, errText));
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls
        .filter((tc: any) => tc?.function?.name)
        .map((tc: any) => ({ id: tc.id, name: tc.function.name, args: safeParseArgs(tc.function.arguments) }))
    : [];
  return { toolCalls, content: msg.content || '', assistantMessage: msg };
}

export async function handleFetchCustomModels(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = request.url as string;
  if (url === BUILTIN_GEMINI_SENTINEL) return { models: ['gemini-nano'] };
  const apiKey = request.apiKey as string;
  if (!url) throw new Error('Missing Custom Base URL');

  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // standard OpenAI models endpoint
  const endpoint = url.endsWith('/v1') ? `${url}/models` : url.endsWith('/models') ? url : `${url.replace(/\/+$/, '')}/models`;

  const res = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`Custom provider error: ${res.status}`);
  const data = await res.json();
  const models = data.data ? data.data.map((m: any) => m.id) : [];
  return { models };
}

