// ─────────────────────────────────────────────
// GitHub Copilot SSO — Device Code OAuth flow
// ─────────────────────────────────────────────
// Zero-config LLM: enterprise users authenticate via GitHub SSO (device code
// flow) and use the Copilot Chat completions API as their endpoint. The API
// is OpenAI-compatible — once we have a session token, it rides the existing
// chatWithCustom/chatWithCustomStream pipeline unchanged.
//
// Flow:
//   1. POST /login/device/code → user_code + verification_uri + device_code
//   2. User visits verification_uri, enters user_code (opens in browser tab)
//   3. Poll POST /login/oauth/access_token until user approves → access_token
//   4. Exchange access_token for Copilot session token at /copilot_internal/v2/token
//   5. Use session token as Bearer against api.githubcopilot.com/chat/completions
//   6. Session token expires (~30 min) — auto-refresh using stored access_token

// Copilot's registered OAuth app client_id (public — same one `gh` CLI uses).
// GitHub Enterprise deployments can register their own OAuth app; override it
// via the `githubClientId` setting.
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
/** Default Copilot completions endpoint. Copilot does NOT use OpenAI's /v1 path. */
export const COPILOT_API_URL = 'https://api.githubcopilot.com';
export const COPILOT_DEFAULT_MODEL = 'gpt-4o';
/** Default GitHub host for the OAuth device flow. */
export const DEFAULT_GITHUB_BASE_URL = 'https://github.com';

export interface GithubEndpoints {
  clientId: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  copilotTokenUrl: string;
  copilotApiUrl: string;
}

/**
 * Derive every GitHub/Copilot endpoint from a base host so the same flow works
 * against github.com AND a GitHub Enterprise Server instance. Exported for tests.
 *
 * - github.com          → REST API at `https://api.github.com`
 * - GHES `github.acme`  → REST API at `https://github.acme/api/v3` (GHES convention)
 *
 * The Copilot completions URL is kept separately overridable (some enterprises
 * front it with a proxy); it defaults to the public `api.githubcopilot.com`.
 */
export function resolveGithubEndpoints(
  baseUrl?: string,
  copilotApiUrl?: string,
  clientId?: string,
): GithubEndpoints {
  const withHttps = (raw: string) => /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const normalizeBase = (raw: string) => withHttps(raw.trim()).replace(/\/+$/, '');
  const normalizeApi = (raw: string) => {
    const u = withHttps(raw.trim()).replace(/\/+$/, '');
    // Public Copilot uses /chat/completions (no /v1). Enterprise proxies may
    // expose their own exact base; use what the user provides.
    return u;
  };
  const base = normalizeBase(baseUrl || DEFAULT_GITHUB_BASE_URL);
  const isDotCom = /^https?:\/\/github\.com$/i.test(base);
  const apiBase = isDotCom ? 'https://api.github.com' : `${base}/api/v3`;
  return {
    clientId: (clientId || COPILOT_CLIENT_ID).trim(),
    deviceCodeUrl: `${base}/login/device/code`,
    tokenUrl: `${base}/login/oauth/access_token`,
    copilotTokenUrl: `${apiBase}/copilot_internal/v2/token`,
    copilotApiUrl: copilotApiUrl?.trim() ? normalizeApi(copilotApiUrl) : COPILOT_API_URL,
  };
}

/**
 * Copilot model listing is not consistently OpenAI-compatible. The public API
 * commonly exposes `/models` (not `/v1/models`); some enterprise/proxy setups
 * expose no list endpoint and only accept a known model id in chat completions.
 * In that case return [] instead of inventing models the user's entitlement may
 * not actually allow.
 */
export async function fetchCopilotModels(copilotApiUrl: string, token: string): Promise<string[]> {
  const base = (copilotApiUrl || COPILOT_API_URL).replace(/\/+$/, '');
  const noV1 = base.replace(/\/v1$/i, '');
  const candidates = Array.from(new Set([
    `${base}/models`,
    `${noV1}/models`,
    `${base}/v1/models`,
  ]));
  for (const endpoint of candidates) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Editor-Version': 'vscode/1.95.0',
          'Editor-Plugin-Version': 'copilot-chat/0.22.0',
          'Copilot-Integration-Id': 'vscode-chat',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const models = Array.isArray(data.data) ? data.data.map((m: any) => m.id).filter(Boolean) : [];
      if (models.length) return models;
    } catch { /* try next candidate */ }
  }
  return [];
}

/** Read the user's GitHub host config and resolve the concrete endpoints. */
async function getGithubEndpoints(): Promise<GithubEndpoints> {
  const s = await chrome.storage.local.get(['githubBaseUrl', 'copilotApiUrl', 'githubClientId']);
  return resolveGithubEndpoints(
    s.githubBaseUrl as string | undefined,
    s.copilotApiUrl as string | undefined,
    s.githubClientId as string | undefined,
  );
}

export interface CopilotDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface CopilotAuth {
  accessToken: string;
  /** Short-lived Copilot session token (Bearer for API calls). */
  sessionToken: string;
  sessionExpiresAt: number;
  /** API base returned by the Copilot token exchange, when present. */
  apiEndpoint?: string;
}

const STORAGE_KEY = 'magpie-copilot-auth';

/** Start the device-code flow: returns codes for the user to enter in their browser. */
export async function startCopilotDeviceFlow(): Promise<CopilotDeviceCode> {
  const { deviceCodeUrl, clientId } = await getGithubEndpoints();
  const res = await fetch(deviceCodeUrl, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  const text = await res.text().catch(() => '');
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) {
    const detail = data.error_description || data.error || text || `HTTP ${res.status}`;
    throw new Error(`GitHub device code request failed at ${deviceCodeUrl}: ${res.status} ${detail}`);
  }
  if (!data.user_code || !data.device_code) {
    throw new Error(`GitHub device code response from ${deviceCodeUrl} was missing user_code/device_code. Check the GitHub host URL and OAuth app device-flow support.`);
  }
  return data;
}

/** Poll until the user approves the device code. Resolves with the GitHub access token. */
export async function pollForAccessToken(deviceCode: string, interval: number, expiresIn: number): Promise<string> {
  const { tokenUrl, clientId } = await getGithubEndpoints();
  const deadline = Date.now() + expiresIn * 1000;
  const pollInterval = Math.max(interval, 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.access_token) return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (data.error === 'expired_token') throw new Error('Device code expired — please try again');
    if (data.error === 'access_denied') throw new Error('Access denied by user');
    if (data.error) throw new Error(`OAuth error: ${data.error}`);
  }
  throw new Error('Device code expired — please try again');
}

/** Exchange a GitHub access token for a short-lived Copilot session token. */
export async function getCopilotSessionToken(accessToken: string): Promise<{ token: string; expiresAt: number; apiEndpoint?: string }> {
  const { copilotTokenUrl } = await getGithubEndpoints();
  const res = await fetch(copilotTokenUrl, {
    headers: {
      'Authorization': `token ${accessToken}`,
      'Accept': 'application/json',
      'Editor-Version': 'Magpie/1.0',
      'Editor-Plugin-Version': 'magpie-research-assistant/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Copilot token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('No token in Copilot response');
  return {
    token: data.token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + 25 * 60 * 1000,
    apiEndpoint: typeof data.endpoints?.api === 'string' ? data.endpoints.api.replace(/\/+$/, '') : undefined,
  };
}

/** Get a valid Copilot session token (auto-refreshes if expired). */
export async function getValidCopilotToken(): Promise<string> {
  const s = await chrome.storage.local.get([STORAGE_KEY]);
  const auth = s[STORAGE_KEY] as CopilotAuth | undefined;
  if (!auth?.accessToken) throw new Error('Not signed in to GitHub Copilot');

  // Token still fresh? (5-min buffer)
  if (auth.sessionToken && auth.sessionExpiresAt > Date.now() + 5 * 60 * 1000) {
    return auth.sessionToken;
  }

  // Refresh
  const { token, expiresAt, apiEndpoint } = await getCopilotSessionToken(auth.accessToken);
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...auth, sessionToken: token, sessionExpiresAt: expiresAt, apiEndpoint: apiEndpoint || auth.apiEndpoint } });
  return token;
}

/** Save the access token after successful device-code flow. */
export async function saveCopilotAuth(accessToken: string): Promise<void> {
  const { token, expiresAt, apiEndpoint } = await getCopilotSessionToken(accessToken);
  const { copilotApiUrl } = await getGithubEndpoints();
  const apiBase = apiEndpoint || copilotApiUrl;
  const models = await fetchCopilotModels(apiBase, token);
  const preferred = models.find(m => /gpt-4o|gpt-4\.1/i.test(m)) || models[0] || COPILOT_DEFAULT_MODEL;
  await chrome.storage.local.set({
    [STORAGE_KEY]: { accessToken, sessionToken: token, sessionExpiresAt: expiresAt, apiEndpoint } satisfies CopilotAuth,
    // Copilot provider bucket (separate from BYOK so the picker can list both).
    copilotApiBase: apiBase,
    copilotModels: models,
    // Make Copilot the active provider right after sign-in.
    activeProvider: 'copilot',
    customUrl: apiBase,
    customKey: '__copilot_sso__', // sentinel: getProviderSettings will call getValidCopilotToken
    customModel: preferred,
    customModels: models,
  });
}

/** Check if Copilot SSO is configured. */
export async function isCopilotConfigured(): Promise<boolean> {
  const s = await chrome.storage.local.get([STORAGE_KEY]);
  return !!(s[STORAGE_KEY] as CopilotAuth | undefined)?.accessToken;
}

/** Sign out of Copilot. */
export async function signOutCopilot(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
  const s = await chrome.storage.local.get(['customKey']);
  if (s.customKey === '__copilot_sso__') {
    await chrome.storage.local.remove(['customUrl', 'customKey', 'customModel']);
  }
}
