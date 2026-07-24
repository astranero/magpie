// ─────────────────────────────────────────────
// Turning an error string into a next step
// ─────────────────────────────────────────────
// A failed model call used to reach the user as whatever string was thrown:
// "TypeError: Failed to fetch", "Provider rejected the API key (401): …". True,
// but it leaves the user to work out what to DO.
//
// This classifies the message into a small set of recoveries. It runs on the
// FINAL string — after llm-client's formatProviderError has already turned an
// HTTP status into readable text — so it is a thin, well-tested layer on top of
// that, not a replacement. Everything unrecognised falls through to a plain
// "retry", which is the honest default: most transient failures clear on a
// second attempt.
//
// Pure and string-only: no DOM, no chrome APIs, so it is trivially unit-tested
// against the actual strings the codebase throws.

/** What the user can do about it. The UI maps each to a button. */
export type RecoveryAction = 'settings' | 'retry' | 'none';

export interface Diagnosis {
  /** One short line naming what went wrong. */
  title: string;
  /** The offered recovery. */
  action: RecoveryAction;
  /** Label for the action button, or null when action is 'none'. */
  actionLabel: string | null;
  /** The original message, kept so the user can see the raw detail. */
  detail: string;
}

const has = (s: string, ...needles: string[]) => needles.some(n => s.includes(n));

/**
 * Classify an error message into a recovery.
 *
 * Order matters: the most specific and most actionable causes are checked
 * first, so "401" routes to Settings even though the same string would also
 * match the generic tail.
 */
export function diagnoseError(raw: string | null | undefined): Diagnosis {
  const detail = (raw || '').trim() || 'Something went wrong.';
  const s = detail.toLowerCase();

  const settings = (title: string, label = 'Open Settings'): Diagnosis =>
    ({ title, action: 'settings', actionLabel: label, detail });
  const retry = (title: string): Diagnosis =>
    ({ title, action: 'retry', actionLabel: 'Retry', detail });
  const none = (title: string): Diagnosis =>
    ({ title, action: 'none', actionLabel: null, detail });

  // A user-cancelled turn is not a failure — the caller should usually not even
  // render this, but classify it so nothing shows a scary "retry" for it.
  if (has(s, 'abort') || has(s, 'cancel')) return none('Stopped.');

  // No endpoint / no key configured yet: the one error where retry is useless.
  if (has(s, 'endpoint missing', 'no endpoint', 'configure an openai', 'built-in gemini removed'))
    return settings('No AI provider is set up yet.', 'Set up a provider');
  if (has(s, 'api key', 'apikey') && has(s, 'missing', 'not set', 'no api key'))
    return settings('No API key is set.', 'Add your key');

  // Auth: the key exists but the provider refused it. Retrying sends the same
  // bad key, so route to Settings.
  if (has(s, '401', 'unauthor', 'rejected the api key', 'invalid api key', 'invalid_api_key'))
    return settings('The provider rejected your API key.', 'Fix the key');
  if (has(s, 'copilot sso', 'sign in again'))
    return settings('Your Copilot sign-in expired.', 'Sign in again');

  // Billing / quota: also a Settings trip (add credits or a different key).
  if (has(s, '402', 'needs credits', 'insufficient', 'quota', 'billing', 'payment required'))
    return settings('The provider needs credits or has hit a quota.');

  // Rate limit: genuinely transient — retry (formatProviderError may already
  // carry a "retry in Ns" hint in the detail).
  if (has(s, '429', 'rate-limit', 'rate limit', 'too many requests'))
    return retry('The provider rate-limited the request.');

  // Wrong or unavailable model: a Settings fix (pick another model).
  if ((has(s, 'model') && has(s, 'not found', 'does not exist', 'no such', 'unavailable', 'decommission', 'invalid model')) || has(s, 'unknown model'))
    return settings('That model is not available.', 'Pick a model');

  // Network: fetch itself failed — no response, no status. Could be the
  // endpoint URL, could be the connection. Both live in Settings, but retry is
  // also reasonable for a blip, so offer retry and name the likely cause.
  if (has(s, 'failed to fetch', 'networkerror', 'load failed', 'err_', 'econnrefused', 'enotfound', 'dns', 'cors'))
    return retry('Could not reach the provider — check your connection or the endpoint URL in Settings.');

  // Timeout: transient by definition.
  if (has(s, 'timed out', 'timeout', 'etimedout', 'deadline'))
    return retry('The request timed out.');

  // Server-side 5xx: the provider's problem, retry.
  if (has(s, '500', '502', '503', '504', 'having trouble', 'internal error', 'bad gateway', 'service unavailable'))
    return retry('The provider is having trouble.');

  // Everything else: retry is the safe default.
  return retry('That request failed.');
}
