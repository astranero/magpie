import { describe, it, expect } from 'vitest';
import { formatProviderError } from '../llm-client';

describe('formatProviderError', () => {
  it('surfaces the nested OpenRouter cause + retry hint instead of the raw JSON blob', () => {
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 429,
        metadata: {
          raw: 'moonshotai/kimi-k3 is temporarily rate-limited upstream. Please retry shortly, or add your own key.',
          provider_name: 'Moonshot AI',
          retry_after_seconds: 18,
        },
      },
      user_id: 'user_123',
    });
    const msg = formatProviderError(429, body);
    expect(msg).toContain('rate-limited the request (429)');
    expect(msg).toContain('kimi-k3 is temporarily rate-limited upstream');
    expect(msg).toContain('Retry in ~18s');
    expect(msg).not.toContain('user_123');
    expect(msg).not.toContain('{"error"');
  });

  it('uses error.message when it is specific', () => {
    const msg = formatProviderError(401, JSON.stringify({ error: { message: 'Invalid API key provided' } }));
    expect(msg).toContain('rejected the API key (401)');
    expect(msg).toContain('Invalid API key provided');
  });

  it('keeps plain-text bodies and caps length', () => {
    const msg = formatProviderError(503, 'upstream timeout\n'.repeat(100));
    expect(msg).toContain('having trouble (503)');
    expect(msg.length).toBeLessThan(400);
  });
});
