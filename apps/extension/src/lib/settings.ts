// ─────────────────────────────────────────────
// Central settings constants + URL policy
// ─────────────────────────────────────────────
// These literals used to be copy-pasted across App.tsx, SettingsView.tsx,
// service-worker.ts and companion-mcp.js (the companion URL lived in SIX
// places; context-token and enum defaults in 3-4). They drifted. One home now.

/** Default local MCP companion endpoint (terminal CLI gateway). */
export const DEFAULT_COMPANION_MCP_URL = 'http://localhost:3920/mcp';

/** Default Google Drive folder name for optional sync. */
export const DEFAULT_DRIVE_FOLDER = 'Magpie';

/** Default CLI template sentinel: auto-detect an installed CLI. */
export const CLI_TEMPLATE_AUTO = 'auto';

/**
 * Provider endpoint policy (same bar as MCP URLs): https everywhere, plain
 * http only for loopback. A remote http:// endpoint would send the user's API
 * key in cleartext.
 */
export function isAllowedProviderUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      const h = u.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
    }
    return false;
  } catch {
    return false;
  }
}
