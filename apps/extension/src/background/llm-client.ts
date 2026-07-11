// ─────────────────────────────────────────────
// LLM client — OpenAI-compatible provider (chat, streaming, models)
// ─────────────────────────────────────────────
// Extracted from service-worker.ts. Depends only on chrome.storage config +
// fetch — no DB, caches, or worker state. Guarded by e2e/chat.spec.ts.

export async function getProviderSettings(): Promise<Record<string, string>> {
  const s = await chrome.storage.local.get(['customUrl', 'customKey', 'customModel', 'visionModel']);
  const endpoint = s.customUrl ? (s.customUrl.endsWith('/chat/completions') ? s.customUrl : `${s.customUrl.replace(/\/+$/, '')}/chat/completions`) : '';
  return {
    apiKey: s.customKey || '',
    endpoint,
    model: s.customModel || '',
    visionModel: s.visionModel || ''
  };
}


export async function chatWithCustom(systemPrompt: string, history: any[], userPrompt: string, signal?: AbortSignal): Promise<string> {
  const { apiKey, endpoint, model } = await getProviderSettings();
  if (!endpoint) throw new Error('Custom endpoint missing.');

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
    throw new Error(`Custom provider error ${res.status}: ${errText}`);
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
    throw new Error(`Custom provider error ${res.status}: ${errText}`);
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

export async function handleFetchCustomModels(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = request.url as string;
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

