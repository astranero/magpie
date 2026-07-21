import { describe, it, expect } from 'vitest';
import { resolveGithubEndpoints, COPILOT_API_URL, DEFAULT_GITHUB_BASE_URL } from '../copilot-auth';

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
