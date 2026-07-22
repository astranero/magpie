import { describe, it, expect } from 'vitest';
import { resolveGithubEndpoints, normalizeCopilotApiBase, COPILOT_API_URL, COPILOT_EDITOR_HEADERS, DEFAULT_GITHUB_BASE_URL } from '../copilot-auth';
import { buildProviderHeaders } from '../../background/llm-client';

describe('resolveGithubEndpoints', () => {
  it('defaults to github.com + api.github.com when no base is given', () => {
    const e = resolveGithubEndpoints();
    expect(e.deviceCodeUrl).toBe('https://github.com/login/device/code');
    expect(e.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(e.copilotTokenUrl).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(e.copilotApiUrl).toBe(COPILOT_API_URL);
    expect(DEFAULT_GITHUB_BASE_URL).toBe('https://github.com');
  });

  it('derives GHES endpoints under /api/v3 for an enterprise host', () => {
    const e = resolveGithubEndpoints('https://github.acme.com');
    expect(e.deviceCodeUrl).toBe('https://github.acme.com/login/device/code');
    expect(e.tokenUrl).toBe('https://github.acme.com/login/oauth/access_token');
    expect(e.copilotTokenUrl).toBe('https://github.acme.com/api/v3/copilot_internal/v2/token');
  });

  it('accepts a bare GHES hostname from the UI and adds https://', () => {
    const e = resolveGithubEndpoints('shs.ghe.com');
    expect(e.deviceCodeUrl).toBe('https://shs.ghe.com/login/device/code');
    expect(e.copilotTokenUrl).toBe('https://shs.ghe.com/api/v3/copilot_internal/v2/token');
  });

  it('trims trailing slashes on the base host', () => {
    const e = resolveGithubEndpoints('https://github.acme.com/');
    expect(e.copilotTokenUrl).toBe('https://github.acme.com/api/v3/copilot_internal/v2/token');
  });

  it('treats github.com as dot-com regardless of trailing slash / case', () => {
    expect(resolveGithubEndpoints('https://GITHUB.com/').copilotTokenUrl)
      .toBe('https://api.github.com/copilot_internal/v2/token');
  });

  it('honors a Copilot API URL override (enterprise proxy) and trims it', () => {
    const e = resolveGithubEndpoints('https://github.acme.com', 'https://copilot.acme.com/v1/');
    expect(e.copilotApiUrl).toBe('https://copilot.acme.com/v1');
  });

  it('adds https:// to a bare Copilot API proxy host without forcing /v1', () => {
    const e = resolveGithubEndpoints('github.acme.com', 'copilot.acme.com');
    expect(e.copilotApiUrl).toBe('https://copilot.acme.com');
  });

  it('honors a custom OAuth client id', () => {
    expect(resolveGithubEndpoints(undefined, undefined, 'Iv1.custom').clientId).toBe('Iv1.custom');
  });
});

describe('normalizeCopilotApiBase', () => {
  // Regression: the /copilot_internal/v2/token exchange answers with
  // endpoints.api = "https://api.githubcopilot.com" (no /v1). saveCopilotAuth
  // preferred that over COPILOT_API_URL and wrote it to customUrl, so every
  // chat message 401'd with "No user or org id found in auth cookie".
  it('forces /v1 on the public Copilot host', () => {
    expect(normalizeCopilotApiBase('https://api.githubcopilot.com')).toBe(COPILOT_API_URL);
    expect(normalizeCopilotApiBase('https://api.githubcopilot.com/')).toBe(COPILOT_API_URL);
  });

  it('is idempotent — never doubles /v1', () => {
    expect(normalizeCopilotApiBase(COPILOT_API_URL)).toBe(COPILOT_API_URL);
    expect(normalizeCopilotApiBase(normalizeCopilotApiBase('https://api.githubcopilot.com'))).toBe(COPILOT_API_URL);
  });

  it('leaves an enterprise proxy base exactly as provided', () => {
    expect(normalizeCopilotApiBase('https://copilot.acme.com')).toBe('https://copilot.acme.com');
    expect(normalizeCopilotApiBase('https://copilot.acme.com/api/v2/')).toBe('https://copilot.acme.com/api/v2');
  });

  it('falls back to the default for empty/garbage input', () => {
    expect(normalizeCopilotApiBase('')).toBe(COPILOT_API_URL);
    expect(normalizeCopilotApiBase('not a url')).toBe('not a url');
  });
});

describe('buildProviderHeaders', () => {
  it('sends the editor-identity headers for Copilot, from the shared constant', () => {
    const h = buildProviderHeaders('tok', true);
    expect(h['Authorization']).toBe('Bearer tok');
    // Every canonical header must be present — a one-sided drift here is what
    // reintroduces the 401.
    for (const [k, v] of Object.entries(COPILOT_EDITOR_HEADERS)) expect(h[k]).toBe(v);
  });

  it('does NOT leak GitHub-specific headers to a BYOK provider', () => {
    const h = buildProviderHeaders('sk-user-key', false);
    expect(h['Authorization']).toBe('Bearer sk-user-key');
    for (const k of Object.keys(COPILOT_EDITOR_HEADERS)) expect(h[k]).toBeUndefined();
  });

  it('omits Authorization when there is no key (keyless local endpoint)', () => {
    expect(buildProviderHeaders('', false)['Authorization']).toBeUndefined();
  });
});
