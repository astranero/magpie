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

// Copilot's registered OAuth app client_id (public — same one `gh` CLI uses)
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const COPILOT_API_URL = 'https://api.githubcopilot.com/v1';

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
}

const STORAGE_KEY = 'magpie-copilot-auth';

/** Start the device-code flow: returns codes for the user to enter in their browser. */
export async function startCopilotDeviceFlow(): Promise<CopilotDeviceCode> {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: 'read:user' }),
  });
  if (!res.ok) throw new Error(`GitHub device code request failed: ${res.status}`);
  return res.json();
}

/** Poll until the user approves the device code. Resolves with the GitHub access token. */
export async function pollForAccessToken(deviceCode: string, interval: number, expiresIn: number): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  const pollInterval = Math.max(interval, 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    const res = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
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
export async function getCopilotSessionToken(accessToken: string): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(COPILOT_TOKEN_URL, {
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
  return { token: data.token, expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + 25 * 60 * 1000 };
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
  const { token, expiresAt } = await getCopilotSessionToken(auth.accessToken);
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...auth, sessionToken: token, sessionExpiresAt: expiresAt } });
  return token;
}

/** Save the access token after successful device-code flow. */
export async function saveCopilotAuth(accessToken: string): Promise<void> {
  const { token, expiresAt } = await getCopilotSessionToken(accessToken);
  await chrome.storage.local.set({
    [STORAGE_KEY]: { accessToken, sessionToken: token, sessionExpiresAt: expiresAt } satisfies CopilotAuth,
    // Wire the Copilot endpoint as the active provider — it's OpenAI-compatible
    customUrl: COPILOT_API_URL,
    customKey: '__copilot_sso__', // sentinel: getProviderSettings will call getValidCopilotToken
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
