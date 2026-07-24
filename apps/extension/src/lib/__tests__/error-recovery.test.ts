import { describe, it, expect } from 'vitest';
import { diagnoseError } from '../error-recovery';

describe('diagnoseError', () => {
  it('sends missing-config to Settings, never retry', () => {
    for (const raw of [
      'Custom endpoint missing.',
      'Configure an OpenAI-compatible API endpoint in Settings.',
      'Built-in Gemini removed. Configure an OpenAI-compatible API endpoint in Settings.',
    ]) {
      expect(diagnoseError(raw).action).toBe('settings');
    }
  });

  it('routes a rejected key to Settings, because retry resends the same key', () => {
    for (const raw of [
      'Provider rejected the API key (401): invalid token',
      'Error: 401 Unauthorized',
      'invalid_api_key: the key is wrong',
    ]) {
      const d = diagnoseError(raw);
      expect(d.action).toBe('settings');
    }
  });

  it('routes expired Copilot sign-in to Settings', () => {
    expect(diagnoseError('Copilot SSO: token refresh failed — sign in again in Settings.').action).toBe('settings');
  });

  it('treats a rate limit as retryable', () => {
    for (const raw of [
      'Provider rate-limited the request (429)',
      'Error: 429 too many requests',
    ]) {
      expect(diagnoseError(raw).action).toBe('retry');
    }
  });

  it('names an unavailable model and sends it to Settings', () => {
    for (const raw of [
      'The model `gpt-9` does not exist',
      'model not found',
      'unknown model: foo',
    ]) {
      expect(diagnoseError(raw).action).toBe('settings');
    }
  });

  it('treats a bare fetch failure as retryable and mentions the endpoint', () => {
    const d = diagnoseError('TypeError: Failed to fetch');
    expect(d.action).toBe('retry');
    expect(d.title.toLowerCase()).toContain('reach');
  });

  it('classifies a timeout as retryable', () => {
    expect(diagnoseError('Request timed out after 60s').action).toBe('retry');
  });

  it('classifies a 5xx as retryable', () => {
    expect(diagnoseError('Provider is having trouble (503)').action).toBe('retry');
  });

  it('does not offer retry for a user cancel', () => {
    expect(diagnoseError('AbortError: The operation was aborted').action).toBe('none');
    expect(diagnoseError('Cancelled').action).toBe('none');
  });

  it('names an image-input failure and routes to a vision model', () => {
    for (const raw of [
      "This model does not support image input.",
      'Vision is not supported by this model',
      "400: modality 'image' not supported",
      'Unsupported media type (415)',
      'image_url is not accepted by model gpt-4-text',
    ]) {
      const d = diagnoseError(raw);
      expect(d.action, raw).toBe('settings');
      expect(d.actionLabel, raw).toMatch(/vision/i);
    }
  });

  it('falls through to retry for anything unrecognised', () => {
    const d = diagnoseError('some brand new error nobody has seen');
    expect(d.action).toBe('retry');
  });

  it('is empty-safe', () => {
    const d = diagnoseError('');
    expect(d.action).toBe('retry');
    expect(d.detail).toBeTruthy();
  });

  it('always keeps the raw detail so nothing is hidden from the user', () => {
    const raw = 'Provider rejected the API key (401): key ends in ...9f2';
    expect(diagnoseError(raw).detail).toBe(raw);
  });

  it('gives every diagnosis a label exactly when it has an action', () => {
    for (const raw of ['401', '429', 'Failed to fetch', 'endpoint missing', 'Cancelled', 'weird']) {
      const d = diagnoseError(raw);
      if (d.action === 'none') expect(d.actionLabel).toBeNull();
      else expect(d.actionLabel).toBeTruthy();
    }
  });

  it('prefers the auth verdict over the generic tail when both could match', () => {
    // "401 … failed" contains 'failed', which the fallthrough would call retry.
    // Auth must win: retrying an unauthorized call is pointless.
    expect(diagnoseError('Request failed: 401 unauthorized').action).toBe('settings');
  });
});
