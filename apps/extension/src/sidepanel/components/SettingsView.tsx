import { generateCompanionToken } from '../../lib/settings';
import React, { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Section } from './Section';
import { ModelSelect, type ModelEntry } from './ModelSelect';
import { CustomSkill, sanitizeCustomSkill } from '../../lib/commands';
import { McpServerConfig, McpConnection, getMcpServers, saveMcpServers, isAllowedMcpUrl } from '../../lib/mcp-client';
import { SearchApiKeys, getSearchApiKeys, saveSearchApiKeys } from '../../lib/search-providers';
import { getCrashLog, clearCrashLog, formatCrashLog } from '../../lib/crash-log';
import { COPILOT_PENDING_KEY, type CopilotPendingAuth } from '../../lib/copilot-auth';
import { THEMES, THEME_LABELS, THEME_STORAGE_KEY, THEME_CHANGED_EVENT, readThemePref, type ThemePref } from '../../lib/theme';

// ── Appearance ────────────────────────────────────────────────────────────
/**
 * Theme picker. The preference has existed (and been applied on boot) all
 * along, but nothing ever WROTE it — so the app silently followed the OS and
 * the light/dark tokens were unreachable. This is the missing writer.
 *
 * Self-contained on purpose: it owns its own storage read/write and notifies
 * the applier in main.tsx by event, so no theme state has to be threaded
 * through SettingsView's already-large prop surface.
 */
function AppearanceSection() {
  const [theme, setTheme] = useState<ThemePref>(() => {
    try { return readThemePref(localStorage.getItem(THEME_STORAGE_KEY)); } catch { return 'system'; }
  });

  const choose = (next: ThemePref) => {
    setTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* private mode — applies for this session only */ }
    window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
  };

  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2">
      {THEMES.map(t => {
        const active = theme === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => choose(t)}
            className={`flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors ${
              active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
            }`}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <ThemeSwatch theme={t} />
              {THEME_LABELS[t].label}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground leading-normal">
              {THEME_LABELS[t].hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Three dots of each palette — background, primary, signature rule. */
function ThemeSwatch({ theme }: { theme: ThemePref }) {
  // Literal colors, not tokens: a swatch must show the palette you are NOT
  // currently in, so it cannot read var(--primary) off the live theme.
  const dots: Record<ThemePref, [string, string, string]> = {
    system:  ['hsl(210 33% 98%)', 'hsl(228 24% 8%)',  'hsl(200 85% 34%)'],
    light:   ['hsl(210 33% 98%)', 'hsl(200 85% 34%)', 'hsl(262 65% 56%)'],
    dark:    ['hsl(228 24% 8%)',  'hsl(197 75% 58%)', 'hsl(262 70% 68%)'],
    village: ['hsl(38 42% 95%)',  'hsl(145 26% 34%)', 'hsl(345 48% 62%)'],
  };
  return (
    <span className="inline-flex" aria-hidden="true">
      {dots[theme].map((c, i) => (
        <span
          key={i}
          className="h-2.5 w-2.5 rounded-full border border-foreground/15"
          style={{ background: c, marginLeft: i ? -3 : 0 }}
        />
      ))}
    </span>
  );
}

// ── GitHub Copilot SSO section ────────────────────────────────────────────
/**
 * Enterprise GitHub URL field. Rendered in BOTH the signed-in and signed-out
 * Copilot branches (the user sees exactly one), so it lives here rather than
 * being written twice — the two copies had already drifted in styling.
 */
function EnterpriseGitHubField({ value, onChange, placeholder, hint, compact }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  hint: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div>
      <label className="text-[10px] font-medium text-muted-foreground">Enterprise GitHub URL</label>
      <input
        type="url"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`mt-1 w-full rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none ${compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'}`}
      />
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function CopilotSSOSection({ enterpriseGitHubUrl, setEnterpriseGitHubUrl, saveSettings, customModel, copilotModels, activateProviderModel }: {
  enterpriseGitHubUrl: string;
  setEnterpriseGitHubUrl: (v: string) => void;
  saveSettings: () => void;
  /** The live model — shown as selected here only when it IS a Copilot model. */
  customModel: string;
  /** Copilot's OWN catalog — independent of the BYOK section's list, so the
   *  two provider setups can coexist without overwriting each other's view. */
  copilotModels: string[];
  activateProviderModel: (provider: 'copilot' | 'byok', model: string) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'polling' | 'done' | 'error'>('idle');
  const [configured, setConfigured] = useState(false);
  const [userCode, setUserCode] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const msg = (action: string, data?: any) =>
    new Promise<any>((res) => chrome.runtime.sendMessage({ action, ...data }, res));

  // Reflect a pending device-flow record (shared across every panel via storage).
  const applyPending = (p: CopilotPendingAuth | null) => {
    if (!p) return;
    setUserCode(p.userCode);
    setVerifyUrl(p.verificationUri);
    if (p.status === 'done') {
      setStatus('done'); setConfigured(true);
    } else if (p.status === 'error') {
      setStatus('error'); setError(p.error || 'Sign-in failed');
    } else {
      setStatus('polling');
    }
  };

  useEffect(() => {
    msg('COPILOT_STATUS').then(r => { if (r?.configured) setConfigured(true); });
    // Resume/mirror an in-progress sign-in started in this or another panel.
    chrome.storage.local.get(COPILOT_PENDING_KEY).then(s => applyPending(s[COPILOT_PENDING_KEY] || null));
    // Live-sync device code + completion across all open side panels.
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[COPILOT_PENDING_KEY]) return;
      applyPending((changes[COPILOT_PENDING_KEY].newValue as CopilotPendingAuth | undefined) || null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const startSignIn = async () => {
    setStatus('polling'); setError(''); setCopied(false);
    try {
      // Background begins polling immediately and persists the code to storage;
      // the onChanged listener above keeps this and every other panel in sync.
      const codes = await msg('COPILOT_START_DEVICE_FLOW');
      if (!codes?.user_code) throw new Error('No device code returned');
      setUserCode(codes.user_code);
      setVerifyUrl(codes.verification_uri);
    } catch (e: any) {
      setError(e.message || 'Sign-in failed');
      setStatus('error');
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — user can still select the code */ }
  };

  // Open the verification page WITHOUT stealing focus, so the side panel stays
  // put and the user can copy the code first, then switch when ready.
  const openVerification = () => {
    chrome.tabs.create({ url: verifyUrl || 'https://github.com/login/device', active: false });
  };

  const signOut = async () => {
    await msg('COPILOT_SIGN_OUT');
    setConfigured(false); setStatus('idle'); setUserCode(''); setVerifyUrl(''); setError('');
  };

  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [modelsError, setModelsError] = useState('');

  const refreshModels = async () => {
    setModelsRefreshing(true); setModelsError('');
    try {
      const res = await msg('COPILOT_FETCH_MODELS');
      // The background handler persists the new list to chrome.storage.local
      // (customModels/copilotModels); App.tsx's storage.onChanged listener
      // picks that up and flows it back down as the `customModels` prop —
      // no local state duplication needed here.
      if (!res?.success) setModelsError(res?.error || 'Failed to fetch models');
    } catch (e: any) {
      setModelsError(e?.message || 'Failed to fetch models');
    } finally {
      setModelsRefreshing(false);
    }
  };

  if (configured) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-xs font-medium text-foreground">Connected to GitHub Copilot</span>
          {enterpriseGitHubUrl && <span className="text-[10px] text-muted-foreground">({new URL(enterpriseGitHubUrl).hostname})</span>}
        </div>

        {/* Copilot model picker — clearly labeled so it isn't mistaken for the
            BYOK "AI Provider Configuration" model select further down. */}
        <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">GitHub Copilot model</label>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 rounded-md text-[10px] px-2"
              onClick={refreshModels}
              disabled={modelsRefreshing}
            >
              {modelsRefreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          {copilotModels.length > 0 ? (
            <ModelSelect
              aria-label="GitHub Copilot model"
              entries={copilotModels.map(m => ({ model: m, group: 'GitHub Copilot' }))}
              value={copilotModels.includes(customModel) ? customModel : ''}
              placeholder="Select a Copilot model…"
              onSelect={(e: ModelEntry) => activateProviderModel('copilot', e.model)}
            />
          ) : (
            <p className="text-[10px] text-muted-foreground leading-snug">
              {customModel
                ? <>No model list available from your Copilot endpoint — using <span className="font-mono">{customModel}</span>. Some enterprise deployments don't expose a models list; try Refresh, or contact your admin for the exact model id.</>
                : 'No models loaded yet — click Refresh.'}
            </p>
          )}
          {modelsError && <p className="text-[10px] text-destructive">{modelsError}</p>}
        </div>

        <Button variant="secondary" size="sm" className="rounded-lg text-xs" onClick={signOut}>Sign out</Button>
        {/* Enterprise URL config — always visible, even when signed in */}
        <div className="pt-2 border-t border-border">
          <EnterpriseGitHubField
            compact
            value={enterpriseGitHubUrl}
            onChange={v => { setEnterpriseGitHubUrl(v); setTimeout(saveSettings, 0); }}
            placeholder="https://github.acme.com"
            hint="Changed hosts? Click Refresh above to pull that host's model list."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Enterprise URL input at the top */}
      <EnterpriseGitHubField
        value={enterpriseGitHubUrl}
        onChange={v => { setEnterpriseGitHubUrl(v); setTimeout(saveSettings, 0); }}
        placeholder="https://github.acme.com (leave empty for github.com)"
        hint="Used for repo file-tree fetching, raw file content, and Copilot SSO."
      />
      {/* Sign-in button below */}
      <p className="text-[10px] text-muted-foreground leading-normal">
        Sign in with GitHub to use your enterprise Copilot as the AI backend — no API key needed.
      </p>
      {status === 'idle' || status === 'error' ? (
        <>
          <Button variant="default" size="sm" className="rounded-lg text-xs w-full" onClick={startSignIn}>
            Sign in with GitHub
          </Button>
          {error && <p className="text-[10px] text-destructive">{error}</p>}
        </>
      ) : status === 'polling' ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium">1. Copy this code:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-center text-lg font-bold font-mono tracking-widest text-primary select-all">{userCode}</code>
            <Button variant="secondary" size="sm" className="rounded-lg text-xs shrink-0" onClick={copyCode}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs font-medium pt-1">2. Open GitHub and paste it:</p>
          <Button variant="secondary" size="sm" className="rounded-lg text-xs w-full" onClick={openVerification}>
            Open {verifyUrl || 'github.com/login/device'} ↗
          </Button>
          <p className="text-[10px] text-muted-foreground">
            Opens in a background tab so this panel stays open. The code also appears in any other tab's panel.
          </p>
          <p className="text-[10px] text-muted-foreground animate-pulse">Waiting for authorization…</p>
          <Button variant="ghost" size="sm" className="rounded-lg text-xs w-full mt-1" onClick={() => { setStatus('idle'); setError(''); }}>Cancel</Button>
        </div>
      ) : (
        <p className="text-xs text-green-600 font-medium">Connected successfully. Reload the panel to start chatting.</p>
      )}
    </div>
  );
}

interface SettingsViewProps {
  customUrl: string;
  setCustomUrl: (val: string) => void;
  customKey: string;
  setCustomKey: (val: string) => void;
  customModel: string;
  setCustomModel: (val: string) => void;
  visionModel: string;
  setVisionModel: (val: string) => void;
  classificationModel: string;
  setClassificationModel: (val: string) => void;
  customModels: string[];
  copilotModels: string[];
  byokModels: string[];
  /** Make provider+model the live config — single writer shared with the chat header. */
  activateProviderModel: (provider: 'copilot' | 'byok', model: string) => void;
  fetchCustomModels: () => void;

  docCount: number;
  globalDocCount: number;
  onCleanupOrphans: () => void;
  authed: boolean;
  profile: { name: string; email: string; picture: string } | null;
  login: () => void;
  logout: () => void;
  folderName: string;
  setFolderName: (val: string) => void;
  exportWorkspace: () => void;
  autoLinkCaptures: boolean;
  setAutoLinkCaptures: (val: boolean) => void;
  saveSettings: () => void;
  syncResearchSources: boolean;
  setSyncResearchSources: (val: boolean) => void;
  forceResync: () => void;
  routeChatThroughCli: string;
  setRouteChatThroughCli: (val: string) => void;
  cliCommandTemplate: string;
  setCliCommandTemplate: (val: string) => void;
  localMcpCompanionUrl: string;
  setLocalMcpCompanionUrl: (val: string) => void;
  enterpriseGitHubUrl: string;
  setEnterpriseGitHubUrl: (val: string) => void;
  workspaceName: string;
  workspaceRules: string;
  saveWorkspaceRules: (rules: string) => void | Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  customUrl, setCustomUrl, customKey, setCustomKey, customModel, visionModel, setVisionModel, classificationModel, setClassificationModel, customModels, copilotModels, byokModels, activateProviderModel, fetchCustomModels,
  docCount, globalDocCount, onCleanupOrphans, authed, profile, login, logout, folderName, setFolderName, exportWorkspace,
  autoLinkCaptures, setAutoLinkCaptures, saveSettings, syncResearchSources, setSyncResearchSources, forceResync,
  routeChatThroughCli, setRouteChatThroughCli, cliCommandTemplate, setCliCommandTemplate,
  localMcpCompanionUrl, enterpriseGitHubUrl, setEnterpriseGitHubUrl,
  workspaceName, workspaceRules, saveWorkspaceRules
}) => {
  // Local draft of the workspace instructions; persisted on blur.
  const [rulesDraft, setRulesDraft] = useState(workspaceRules);
  useEffect(() => { setRulesDraft(workspaceRules); }, [workspaceRules]);

  const [companionToken, setCompanionToken] = useState('');
  useEffect(() => {
    chrome.storage.local.get(['companionToken']).then(r => { if (typeof r.companionToken === 'string') setCompanionToken(r.companionToken); }).catch(() => {});
  }, []);
  const [availableClis, setAvailableClis] = useState<string[]>([]);
  useEffect(() => {
    const checkClis = async () => {
      try {
        // Send the shared secret: against a token-protected companion an
        // unauthenticated probe 401s, availableClis silently empties, and the
        // user concludes the integration is broken.
        const { companionToken: probeToken } = await chrome.storage.local.get(['companionToken']);
        const probeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (probeToken) probeHeaders['Authorization'] = `Bearer ${probeToken}`;
        const res = await fetch(localMcpCompanionUrl || 'http://localhost:3920/mcp', {
          method: 'POST',
          headers: probeHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
              name: 'execute_command',
              arguments: { command: 'which claude; echo "---"; which agy; echo "---"; which copilot; echo "---"; which gh' }
            }
          })
        });
        if (res.ok) {
          const data = await res.json();
          const text = data.result?.content?.[0]?.text || '';
          const parts = text.split('---');
          const found: string[] = [];
          if (parts[0] && !parts[0].includes('not found') && parts[0].trim()) found.push('claude');
          if (parts[1] && !parts[1].includes('not found') && parts[1].trim()) found.push('agy');
          if ((parts[2] && !parts[2].includes('not found') && parts[2].trim()) || (parts[3] && !parts[3].includes('not found') && parts[3].trim())) found.push('copilot');
          setAvailableClis(found);
        } else {
          setAvailableClis([]);
        }
      } catch {
        setAvailableClis([]);
      }
    };
    checkClis();
  }, [localMcpCompanionUrl]);

  // Research settings are self-contained: read/write chrome.storage directly.
  const [researchDepth, setResearchDepth] = useState<'standard' | 'deep' | 'exhaustive'>('standard');
  const [reportLength, setReportLength] = useState<'concise' | 'standard' | 'comprehensive'>('standard');
  const [sourceQuality, setSourceQuality] = useState<'all' | 'high'>('all');
  const [academicDepth, setAcademicDepth] = useState<'abstract' | 'full'>('full');
  const [contextTokens, setContextTokens] = useState('32768');
  const [s2ApiKey, setS2ApiKey] = useState('');
  // Chat web-search fallback — default ON; only an explicit false disables it.
  const [webFallback, setWebFallback] = useState(true);
  const [jinaEnabled, setJinaEnabled] = useState(true);
  // How chat gathers extra detail from the open page (repo files / links).
  const [pageCtxStrategy, setPageCtxStrategy] = useState<'semantic' | 'router' | 'agentic'>('semantic');
  const [inferenceDevice, setInferenceDevice] = useState<'wasm' | 'webgpu'>('wasm');
  const [diagStatus, setDiagStatus] = useState('');
  const [userLocation, setUserLocation] = useState('');
  const tzGuess = (() => { try { return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop()?.replace(/_/g, ' ') || ''; } catch { return ''; } })();
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get(['researchDepth', 'reportLength', 'contextTokens', 's2ApiKey', 'sourceQuality', 'academicDepth', 'chatWebFallback', 'jinaReaderEnabled', 'pageContextStrategy', 'userLocation', 'inferenceDevice']).then(r => {
      if (r.inferenceDevice === 'webgpu') setInferenceDevice('webgpu');
      if (r.researchDepth === 'deep' || r.researchDepth === 'exhaustive') setResearchDepth(r.researchDepth);
      if (r.reportLength === 'concise' || r.reportLength === 'comprehensive') setReportLength(r.reportLength);
      if (r.sourceQuality === 'high') setSourceQuality('high');
      if (r.academicDepth === 'abstract') setAcademicDepth('abstract');
      if (r.contextTokens) setContextTokens(String(r.contextTokens));
      if (r.s2ApiKey) setS2ApiKey(r.s2ApiKey);
      setWebFallback(r.chatWebFallback !== false);
      setJinaEnabled(r.jinaReaderEnabled !== false);
      if (r.pageContextStrategy === 'router' || r.pageContextStrategy === 'agentic') setPageCtxStrategy(r.pageContextStrategy);
      if (typeof r.userLocation === 'string') setUserLocation(r.userLocation);
    });
  }, []);
  const saveResearchSetting = (patch: Record<string, unknown>) => {
    if (typeof chrome !== 'undefined' && chrome.storage) chrome.storage.local.set(patch);
  };

  // Custom slash commands (stored under `customSkills`)
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [newCmd, setNewCmd] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [skillError, setSkillError] = useState('');
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get(['customSkills']).then(r => {
      if (Array.isArray(r.customSkills)) setCustomSkills(r.customSkills);
    });
  }, []);
  const persistSkills = (list: CustomSkill[]) => {
    setCustomSkills(list);
    if (typeof chrome !== 'undefined' && chrome.storage) chrome.storage.local.set({ customSkills: list });
  };
  const addSkill = () => {
    const cmd = newCmd.startsWith('/') ? newCmd : '/' + newCmd;
    const skill = sanitizeCustomSkill({ cmd, desc: newDesc, systemPrompt: newPrompt });
    if (!skill) {
      setSkillError('Trigger must be /lowercase-letters (2-24 chars), not a built-in, and the prompt must not be empty.');
      return;
    }
    if (customSkills.some(sk => sk.cmd === skill.cmd)) {
      setSkillError(`${skill.cmd} already exists — remove it first.`);
      return;
    }
    setSkillError('');
    persistSkills([...customSkills, skill]);
    setNewCmd(''); setNewDesc(''); setNewPrompt('');
  };

  // MCP servers (Streamable HTTP endpoints)
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpToken, setMcpToken] = useState('');
  const [searchKeys, setSearchKeys] = useState<SearchApiKeys>({});
  useEffect(() => { getSearchApiKeys().then(setSearchKeys); }, []);
  const setSearchKey = (provider: keyof SearchApiKeys, value: string) => {
    setSearchKeys(prev => ({ ...prev, [provider]: value }));
  };
  const persistSearchKeys = () => {
    const clean: SearchApiKeys = {};
    (['tavily', 'brave', 'serper', 'jina', 'trustpilot', 'youtube', 'redditId', 'redditSecret'] as const).forEach(k => {
      const v = (searchKeys[k] || '').trim();
      if (v) clean[k] = v;
    });
    saveSearchApiKeys(clean).catch(() => {});
  };
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  const [mcpHealth, setMcpHealth] = useState<Record<string, boolean | undefined>>({});
  const [mcpTokenEdits, setMcpTokenEdits] = useState<Record<string, string>>({});
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  useEffect(() => { getMcpServers().then(setMcpServers); }, []);

  // Auto-probe health endpoints for servers that declare one.
  useEffect(() => {
    const probe = () => {
      for (const srv of mcpServers) {
        if (!srv.healthUrl || !srv.enabled) continue;
        fetch(srv.healthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) })
          .then(r => setMcpHealth(prev => ({ ...prev, [srv.id]: r.ok })))
          .catch(() => setMcpHealth(prev => ({ ...prev, [srv.id]: false })));
      }
    };
    probe();
    const interval = setInterval(probe, 10000);
    return () => clearInterval(interval);
  }, [mcpServers]);

  const persistMcp = (list: McpServerConfig[]) => {
    setMcpServers(list);
    saveMcpServers(list).catch(() => {});
  };
  const addMcpServer = () => {
    const url = mcpUrl.trim();
    // Same policy the runtime enforces (https, or http only to loopback) —
    // previously the form accepted remote http:// URLs that then failed on
    // EVERY call.
    if (!isAllowedMcpUrl(url)) {
      setMcpStatus(prev => ({ ...prev, _new: 'URL must be https, or http only to localhost/127.0.0.1' }));
      return;
    }
    const server: McpServerConfig = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      name: mcpName.trim() || new URL(url).host,
      url,
      enabled: true,
      authToken: mcpToken.trim() || undefined
    };
    persistMcp([...mcpServers, server]);
    setMcpName(''); setMcpUrl(''); setMcpToken('');
    setMcpStatus(prev => ({ ...prev, _new: '' }));
  };
  const testMcpServer = async (server: McpServerConfig) => {
    setMcpStatus(prev => ({ ...prev, [server.id]: 'Testing…' }));
    try {
      const tools = await new McpConnection(server).listTools();
      setMcpStatus(prev => ({
        ...prev,
        [server.id]: tools.length > 0 ? `🟢 ${tools.length} tool(s): ${tools.slice(0, 4).map(t => t.name).join(', ')}` : '🟡 Connected, no tools'
      }));
      if (server.healthUrl) {
        setMcpHealth(prev => ({ ...prev, [server.id]: true }));
      }
    } catch (e: any) {
      setMcpStatus(prev => ({ ...prev, [server.id]: `🔴 ${e.message}` }));
      if (server.healthUrl) {
        setMcpHealth(prev => ({ ...prev, [server.id]: false }));
      }
    }
  };

  // Auto-save the latest values when the component unmounts
  const saveSettingsRef = useRef(saveSettings);
  useEffect(() => {
    saveSettingsRef.current = saveSettings;
  }, [saveSettings]);

  useEffect(() => {
    return () => {
      saveSettingsRef.current();
    };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto no-scrollbar">
      {/* ── Workspace instructions ── */}
      <Section id="workspace-rules" title="Workspace Instructions" subtitle={`Persistent context for "${workspaceName.length > 48 ? workspaceName.slice(0, 45) + '…' : workspaceName}" — added to every prompt.`}>
          <textarea
            value={rulesDraft}
            onChange={e => setRulesDraft(e.target.value)}
            onBlur={() => { if (rulesDraft !== workspaceRules) saveWorkspaceRules(rulesDraft); }}
            placeholder={"Tell Magpie your baseline rules (e.g. stack, formatting preferences, coding rules)."}
            rows={4}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-[10px] text-muted-foreground leading-normal">
            Applies only to this workspace. Saved automatically.
          </p>
      </Section>

      {/* ── GitHub Copilot SSO ── */}
      <Section id="copilot" title="GitHub Copilot" subtitle="Sign in with your enterprise GitHub account. Set your enterprise URL below if using GHES." defaultOpen={true}>
        <CopilotSSOSection
          enterpriseGitHubUrl={enterpriseGitHubUrl}
          setEnterpriseGitHubUrl={setEnterpriseGitHubUrl}
          saveSettings={saveSettings}
          customModel={customModel}
          copilotModels={copilotModels}
          activateProviderModel={activateProviderModel}
        />
      </Section>

      {/* ── Custom Provider ── */}
      <Section id="provider" title="AI Provider Configuration" subtitle="Configure your AI backend (or use Copilot above).">
          {/* Which backend will actually receive the next request — computed
              from the SAME settings the client reads, so it can't lie. Answers
              "am I really on enterprise Copilot or on OpenRouter?" at a glance. */}
          {(() => {
            const host = (() => { try { return new URL(customUrl).host; } catch { return customUrl || ''; } })();
            const isCopilotActive = customKey === '__copilot_sso__';
            const isCliActive = routeChatThroughCli !== 'disabled';
            const label = isCliActive
              ? `Local CLI (${cliCommandTemplate === 'auto' ? 'auto' : cliCommandTemplate.split(' ')[0]})`
              : isCopilotActive
                ? `GitHub Copilot — ${host || 'api.githubcopilot.com'}`
                : host ? `Custom provider — ${host}` : 'Not configured';
            const ok = isCliActive || isCopilotActive || !!host;
            return (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
                <span className="text-xs font-medium">Active:</span>
                <span className="text-xs font-mono text-muted-foreground truncate" title={customUrl}>{label}</span>
                {!isCliActive && !isCopilotActive && customModel && (
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground/70 truncate">{customModel}</span>
                )}
              </div>
            );
          })()}
          {availableClis.length > 0 && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 space-y-2">
              <div className="text-[10px] font-semibold text-primary uppercase tracking-wider">Detected Local Options</div>
              {availableClis.map(cli => {
                const label = cli === 'claude' ? 'Claude' : cli === 'agy' ? 'Antigravity' : 'GitHub Copilot';
                const template = cli === 'claude' ? 'claude "{prompt}"' : cli === 'agy' ? 'agy chat "{prompt}"' : 'copilot explain "{prompt}"';
                const isCurrent = routeChatThroughCli !== 'disabled' && cliCommandTemplate === template;
                return (
                  <button
                    type="button"
                    key={cli}
                    className={`w-full text-left rounded-md border px-2.5 py-1.5 text-xs transition-colors flex flex-col ${isCurrent ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary'}`}
                    onClick={() => {
                      setRouteChatThroughCli('enabled');
                      setCliCommandTemplate(template);
                      setTimeout(saveSettings, 0);
                    }}
                  >
                    <span className="font-semibold flex items-center gap-1.5">
                      Use Local CLI ({label})
                      {isCurrent && <span className="text-[10px] text-primary">● Active</span>}
                    </span>
                    <span className="text-[10px] text-muted-foreground">Routes chat directly to your local `{cli}` command.</span>
                  </button>
                );
              })}
              {availableClis.length > 0 && (
                <button
                  type="button"
                  className={`w-full text-left rounded-md border px-2.5 py-1.5 text-xs transition-colors flex flex-col ${routeChatThroughCli !== 'disabled' && cliCommandTemplate === 'auto' ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary'}`}
                  onClick={() => {
                    setRouteChatThroughCli('enabled');
                    setCliCommandTemplate('auto');
                    setTimeout(saveSettings, 0);
                  }}
                >
                  <span className="font-semibold flex items-center gap-1.5">
                    Use Smart CLI Auto-Select
                    {routeChatThroughCli !== 'disabled' && cliCommandTemplate === 'auto' && <span className="text-[10px] text-primary">● Active</span>}
                  </span>
                  <span className="text-[10px] text-muted-foreground">Automatically routes to the best available local CLI (Claude, AGY, or Copilot).</span>
                </button>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Base URL</label>
            <Input 
              type="text" 
              placeholder="https://openrouter.ai/api/v1" 
              value={customUrl} 
              onChange={e => setCustomUrl(e.target.value)} 
              onBlur={saveSettings}
              className="rounded-lg text-xs"
            />
</div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">API Key</label>
            <Input 
              type="password" 
              placeholder="sk-..." 
              value={customKey} 
              onChange={e => setCustomKey(e.target.value)} 
              onBlur={saveSettings}
              className="rounded-lg text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Model</label>
            <p className="text-[10px] text-muted-foreground font-mono leading-normal">Your API-provider catalog. Selecting here makes this provider active — it never touches your Copilot setup above.</p>
            <div className="flex gap-2">
              <ModelSelect
                aria-label="AI provider model"
                entries={[
                  ...(byokModels.length ? byokModels : customModels).map(m => ({ model: m, group: 'Provider models', meta: 'model' })),
                  ...(availableClis.length > 0 ? [
                    { model: 'Local CLI (Smart Auto-Select)', group: 'Local CLI', meta: 'cli-auto' },
                    ...(availableClis.includes('claude') ? [{ model: 'Local CLI (Claude)', group: 'Local CLI', meta: 'cli-claude' }] : []),
                    ...(availableClis.includes('agy') ? [{ model: 'Local CLI (Antigravity)', group: 'Local CLI', meta: 'cli-agy' }] : []),
                    ...(availableClis.includes('copilot') ? [{ model: 'Local CLI (GitHub Copilot)', group: 'Local CLI', meta: 'cli-copilot' }] : []),
                  ] : []),
                ]}
                value={routeChatThroughCli !== 'disabled'
                  ? (cliCommandTemplate === 'auto' ? 'Local CLI (Smart Auto-Select)' : cliCommandTemplate.startsWith('claude') ? 'Local CLI (Claude)' : cliCommandTemplate.startsWith('agy') ? 'Local CLI (Antigravity)' : 'Local CLI (GitHub Copilot)')
                  : customModel}
                allowCustom
                placeholder="Select or type a model id…"
                onSelect={(e: ModelEntry) => {
                  const meta = String(e.meta || '');
                  if (meta.startsWith('cli-')) {
                    setRouteChatThroughCli('enabled');
                    if (meta === 'cli-auto') setCliCommandTemplate('auto');
                    else if (meta === 'cli-claude') setCliCommandTemplate('claude "{prompt}"');
                    else if (meta === 'cli-agy') setCliCommandTemplate('agy chat "{prompt}"');
                    else setCliCommandTemplate('copilot explain "{prompt}"');
                    setTimeout(saveSettings, 0);
                    return;
                  }
                  setRouteChatThroughCli('disabled');
                  activateProviderModel('byok', e.model);
                }}
              />
              <Button variant="secondary" size="sm" onClick={fetchCustomModels} className="rounded-lg font-medium text-xs shrink-0">Fetch</Button>
            </div>
          </div>

          <div className="space-y-1.5 pt-2 border-t border-border/60">
            <label className="text-xs font-medium">Fast Model <span className="text-[10px] text-muted-foreground font-normal">(classification)</span></label>
            <p className="text-[10px] text-muted-foreground font-mono leading-normal">Used for intent rewriting, routing decisions, and page-relevance checks. A smaller model here speeds up chat. Falls back to your main model when empty.</p>
            <ModelSelect
              aria-label="Fast classification model"
              entries={[
                { model: '— Use Main Model —', group: 'Default', meta: 'unset' },
                ...byokModels.map(m => ({ model: m, group: 'AI Provider' })),
                ...copilotModels.map(m => ({ model: m, group: 'GitHub Copilot' })),
                ...(!byokModels.length && !copilotModels.length ? customModels.map(m => ({ model: m, group: 'Models' })) : []),
              ]}
              value={classificationModel || '— Use Main Model —'}
              allowCustom
              placeholder="Select a fast model…"
              onSelect={(e: ModelEntry) => {
                const v = e.meta === 'unset' ? '' : e.model;
                setClassificationModel(v);
                chrome.storage.local.set({ classificationModel: v });
              }}
            />
          </div>

          {/* Companion shared secret. The companion exposes a shell-exec
              endpoint on localhost; without a token it "will run ANY shell
              command any local caller sends" — and until now the extension had
              no way to set one, so every real deployment ran wide open. Any web
              page can POST to localhost, but cannot READ this token. */}
          {availableClis.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-border/60">
              <label className="text-xs font-medium">Companion token <span className="text-[10px] text-muted-foreground font-normal">(local CLI auth)</span></label>
              <p className="text-[10px] text-muted-foreground font-mono leading-normal">
                Start the companion with the SAME value as <code>MAGPIE_COMPANION_TOKEN</code>. Without it, any web page you visit can drive the companion's shell-exec endpoint.
              </p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={companionToken}
                  onChange={e => setCompanionToken(e.target.value)}
                  onBlur={() => chrome.storage.local.set({ companionToken: companionToken.trim() })}
                  placeholder="Generate one, then pass it to the companion"
                  className="rounded-lg text-xs flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-lg font-medium text-xs shrink-0"
                  onClick={() => {
                    const t = generateCompanionToken();
                    setCompanionToken(t);
                    chrome.storage.local.set({ companionToken: t });
                    navigator.clipboard?.writeText(t).catch(() => {});
                  }}
                >Generate + copy</Button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Vision Model</label>
            <ModelSelect
              aria-label="Vision model"
              entries={[
                { model: '— Use Text Model —', group: 'Default', meta: 'unset' },
                ...byokModels.map(m => ({ model: m, group: 'AI Provider' })),
                ...copilotModels.map(m => ({ model: m, group: 'GitHub Copilot' })),
                ...(!byokModels.length && !copilotModels.length ? customModels.map(m => ({ model: m, group: 'Models' })) : []),
              ]}
              value={visionModel || '— Use Text Model —'}
              allowCustom
              placeholder="Select a vision model…"
              onSelect={(e: ModelEntry) => { setVisionModel(e.meta === 'unset' ? '' : e.model); setTimeout(saveSettings, 0); }}
            />
            <p className="text-[10px] text-muted-foreground font-mono">Used for reading images & scanned PDFs (uses text model if blank).</p>
          </div>
      </Section>

      {/* ── Appearance ── */}
      <Section id="appearance" title="Appearance" subtitle="Pick a palette. Village is a warm light theme.">
        <AppearanceSection />
      </Section>

      {/* ── Capture Behavior ── */}
      <Section id="capture" title="Capture" subtitle="Configure page clipping settings.">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-xs font-medium">Auto-add to active workspace</span>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
              Link new captures to the active workspace automatically.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoLinkCaptures}
            onClick={() => setAutoLinkCaptures(!autoLinkCaptures)}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
              autoLinkCaptures ? 'bg-primary' : 'bg-border'
            }`}
            title="Toggle auto-add captures"
          >
            <span
              className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200 ${
                autoLinkCaptures ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </Section>

      {/* ── Keyboard Shortcuts ── */}
      <Section id="shortcuts" title="Keyboard Shortcuts" subtitle="Quick access keyboard triggers.">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <span className="text-xs font-semibold text-foreground">Toggle Side Panel</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
                Press <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[9px] font-sans font-bold shadow-sm">Alt + M</kbd> (Mac: <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[9px] font-sans font-bold shadow-sm">Option + M</kbd>).
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs shrink-0 rounded-lg border-primary/20 hover:border-primary/40 hover:bg-primary/5 text-primary font-medium"
              onClick={() => {
                if (typeof chrome !== 'undefined' && chrome.tabs) {
                  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
                }
              }}
            >
              Configure
            </Button>
          </div>

          <div className="flex items-center justify-between gap-3 pt-3 border-t border-border/40">
            <div className="min-w-0 flex-1">
              <span className="text-xs font-semibold text-foreground">Capture Page Instantly</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
                Press <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[9px] font-sans font-bold shadow-sm">Alt + C</kbd> (Mac: <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[9px] font-sans font-bold shadow-sm">Option + C</kbd>) on any page to clip it to your workspace with a toast notification.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Answering behavior ── */}
      <Section id="answering" title="Answering" subtitle="Configure response generation sources.">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-xs font-medium">Search the web when nothing matches (chat)</span>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
              Query search engines in chat if your workspace and open page can't answer. /research always searches.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={webFallback}
            onClick={() => { const next = !webFallback; setWebFallback(next); saveResearchSetting({ chatWebFallback: next }); }}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
              webFallback ? 'bg-primary' : 'bg-border'
            }`}
            title="Toggle web-search fallback"
          >
            <span
              className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200 ${
                webFallback ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-xs font-medium">Jina Reader proxy for research scraping</span>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
              Scrape web content through r.jina.ai for high-quality parser extraction.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={jinaEnabled}
            onClick={() => { const next = !jinaEnabled; setJinaEnabled(next); saveResearchSetting({ jinaReaderEnabled: next }); }}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
              jinaEnabled ? 'bg-primary' : 'bg-border'
            }`}
            title="Toggle Jina Reader proxy"
          >
            <span
              className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200 ${
                jinaEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium">Page context — gathering extra detail</label>
          <Select value={pageCtxStrategy} onValueChange={(v) => { setPageCtxStrategy(v as any); saveResearchSetting({ pageContextStrategy: v }); }}>
            <SelectTrigger className="w-full rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              <SelectItem value="semantic" className="font-mono text-xs">Semantic — rank &amp; load only relevant files/links (fastest)</SelectItem>
              <SelectItem value="router" className="font-mono text-xs">Router — a quick model call picks what to open (+1 step)</SelectItem>
              <SelectItem value="agentic" className="font-mono text-xs">Agentic — the model opens files/links/web on demand (strong models)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Selection strategy for scanning open page links (semantic is fast; router/agentic analyze more).
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium">Your location</label>
          <input
            type="text"
            value={userLocation}
            onChange={(e) => setUserLocation(e.target.value)}
            onBlur={() => saveResearchSetting({ userLocation: userLocation.trim() })}
            placeholder={tzGuess ? `e.g. ${tzGuess}` : 'City, region or country'}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Used for location-dependent context (weather, time, "near me"). Kept on-device.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium">Inference acceleration</label>
          <Select value={inferenceDevice} onValueChange={(v) => { setInferenceDevice(v as any); saveResearchSetting({ inferenceDevice: v }); }}>
            <SelectTrigger className="w-full rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              <SelectItem value="wasm" className="font-mono text-xs">WASM (CPU) — stable, recommended</SelectItem>
              <SelectItem value="webgpu" className="font-mono text-xs">WebGPU (GPU) — faster, can crash on big runs</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            ONNX execution device (WebGPU is faster; WASM is memory-stable).
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium">Diagnostics</label>
          <div className="flex gap-2 items-center">
            <button
              className="flex-1 h-8 text-xs font-medium rounded-lg border border-border hover:bg-muted transition-colors"
              onClick={async () => {
                const log = await getCrashLog();
                const text = log.length ? formatCrashLog(log) : '(no breadcrumbs recorded)';
                try { await navigator.clipboard.writeText(text); setDiagStatus(`Copied ${log.length} breadcrumb(s)`); }
                catch { setDiagStatus('Copy failed'); }
                setTimeout(() => setDiagStatus(''), 3000);
              }}
            >
              Copy crash log
            </button>
            <button
              className="h-8 px-3 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground"
              onClick={async () => { await clearCrashLog(); setDiagStatus('Cleared'); setTimeout(() => setDiagStatus(''), 2000); }}
            >
              Clear
            </button>
          </div>
          {diagStatus && <p className="text-[10px] text-primary font-mono">{diagStatus}</p>}
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Breadcrumbs survive worker restarts. Share after crashes to diagnose.
          </p>
        </div>
      </Section>

      {/* ── Research ── */}
      <Section id="research" title="Research" subtitle="Configure deep research parameters.">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Research depth</label>
          <Select value={researchDepth} onValueChange={(v) => { setResearchDepth(v as any); saveResearchSetting({ researchDepth: v }); }}>
            <SelectTrigger className="w-full rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              <SelectItem value="standard" className="font-mono text-xs">Standard — up to 40 sources</SelectItem>
              <SelectItem value="deep" className="font-mono text-xs">Deep — up to 160 sources</SelectItem>
              <SelectItem value="exhaustive" className="font-mono text-xs">Exhaustive — up to 240 sources</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Scales query stages for /research and /deepresearch.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Report length</label>
          <Select value={reportLength} onValueChange={(v) => { setReportLength(v as any); saveResearchSetting({ reportLength: v }); }}>
            <SelectTrigger className="w-full rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              <SelectItem value="concise" className="font-mono text-xs">Concise — ~900-1500 words</SelectItem>
              <SelectItem value="standard" className="font-mono text-xs">Standard — ~1800-3000 words</SelectItem>
              <SelectItem value="comprehensive" className="font-mono text-xs">Comprehensive — ~2800-4500 words</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Shapes report synthesis compression.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Source quality</label>
          <Select value={sourceQuality} onValueChange={(v) => { setSourceQuality(v as any); saveResearchSetting({ sourceQuality: v }); }}>
            <SelectTrigger className="w-full rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              <SelectItem value="all" className="font-mono text-xs">All sources — includes blogs/forums</SelectItem>
              <SelectItem value="high" className="font-mono text-xs">High-authority only — journals, cited papers</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            High-quality filters keep reputable domains and highly cited papers only.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Academic paper depth</label>
          <Select value={academicDepth} onValueChange={(v) => { setAcademicDepth(v as any); saveResearchSetting({ academicDepth: v }); }}>
            <SelectTrigger className="w-full rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              <SelectItem value="abstract" className="font-mono text-xs">Abstracts only — fast and stable</SelectItem>
              <SelectItem value="full" className="font-mono text-xs">Full text — rich synthesis (long PDFs)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Abstracts are fallback if local PDF processing exceeds memory limits.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Model context window (tokens)</label>
          <Input
            type="number"
            min={2048}
            step={1024}
            value={contextTokens}
            onChange={e => setContextTokens(e.target.value)}
            onBlur={() => saveResearchSetting({ contextTokens: Math.max(2048, Number(contextTokens) || 32768) })}
            className="rounded-lg text-xs"
          />
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Synthesis tokens budget. Match model's true window.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Semantic Scholar API key (optional)</label>
          <Input
            type="password"
            placeholder="Key for higher academic rate limits"
            value={s2ApiKey}
            onChange={e => setS2ApiKey(e.target.value)}
            onBlur={() => saveResearchSetting({ s2ApiKey: s2ApiKey.trim() })}
            className="rounded-lg text-xs"
          />
        </div>
      </Section>

      {/* ── Custom Commands ── */}
      <Section id="skills" title="Custom Commands" subtitle="Register custom slash prompts." defaultOpen={false}>
        {customSkills.length > 0 && (
          <div className="space-y-2">
            {customSkills.map(sk => (
              <div key={sk.cmd} className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold font-mono text-primary">{sk.cmd}</div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">{sk.desc}</div>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-destructive"
                  onClick={() => persistSkills(customSkills.filter(x => x.cmd !== sk.cmd))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Trigger</label>
          <Input value={newCmd} onChange={e => setNewCmd(e.target.value)} placeholder="/competitors" className="rounded-lg text-xs" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Description</label>
          <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Research the competitive landscape" className="rounded-lg text-xs" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Prompt</label>
          <textarea
            value={newPrompt}
            onChange={e => setNewPrompt(e.target.value)}
            placeholder="You are a competitive analyst. For the topic, identify competitors..."
            rows={3}
            className="w-full rounded-lg border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
        </div>
        {skillError && <p className="text-[10px] text-destructive font-mono">{skillError}</p>}
        <Button variant="secondary" size="sm" onClick={addSkill} className="rounded-lg font-medium text-xs">Add command</Button>
        <p className="text-[10px] text-muted-foreground font-mono leading-normal">
          Commands execute prompt directives over workspace library context.
        </p>
      </Section>

      {/* ── Research APIs ── */}
      <Section id="research-apis" title="Research APIs" subtitle="API search keys for agent retrieval." defaultOpen={false}>
        {([
          ['tavily', 'Tavily', 'tvly-…'],
          ['brave', 'Brave Search', 'BSA…'],
          ['serper', 'Serper (Google)', '40-char key'],
          ['jina', 'Jina (s.jina.ai)', 'jina_…'],
          ['trustpilot', 'Trustpilot Reviews', 'free key from developers.trustpilot.com'],
          ['youtube', 'YouTube Comments', 'free Google Cloud API key'],
          ['redditId', 'Reddit Client ID', 'from reddit.com/prefs/apps (script)'],
          ['redditSecret', 'Reddit Secret', 'from same Reddit app'],
        ] as const).map(([id, label, ph]) => (
          <div key={id} className="space-y-1.5">
            <label className="text-xs font-medium">{label}</label>
            <Input
              type="password"
              value={searchKeys[id] || ''}
              onChange={e => setSearchKey(id, e.target.value)}
              onBlur={persistSearchKeys}
              placeholder={ph}
              className="rounded-lg text-xs"
            />
          </div>
        ))}
        <p className="text-[10px] text-muted-foreground font-mono leading-normal">
          Preferred over keyless DuckDuckGo scraping. Keys stay local.
        </p>
      </Section>

      {/* ── MCP Servers ── */}
      <Section id="mcp" title="MCP Servers" subtitle="Model Context Protocol HTTP servers." defaultOpen={false}>
        {mcpServers.map(server => (
          <div key={server.id} className="rounded-md border border-border bg-background p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold font-mono truncate">{server.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">{server.url}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={server.enabled}
                title={server.enabled ? 'Enabled' : 'Disabled'}
                onClick={() => persistMcp(mcpServers.map(x => x.id === server.id ? { ...x, enabled: !x.enabled } : x))}
                className={`shrink-0 w-10 h-5 border rounded-full transition-colors relative ${server.enabled ? 'bg-primary border-primary' : 'bg-muted border-border'}`}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-background transition-all ${server.enabled ? 'right-0.5' : 'left-0.5'}`} />
              </button>
              <button
                type="button"
                className="shrink-0 text-[10px] font-medium text-muted-foreground hover:text-primary"
                onClick={() => testMcpServer(server)}
              >
                Test
              </button>
              <button
                type="button"
                className="shrink-0 text-[10px] font-medium text-muted-foreground hover:text-destructive"
                onClick={() => persistMcp(mcpServers.filter(x => x.id !== server.id))}
              >
                Remove
              </button>
            </div>

            {/* Health status for servers with a health endpoint */}
            {server.healthUrl && server.enabled && (
              <div className="text-[10px] font-mono flex items-center gap-1.5 mt-1.5 mb-1">
                {mcpHealth[server.id] === undefined ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse" />
                    <span className="text-muted-foreground">Checking…</span>
                  </>
                ) : mcpHealth[server.id] ? (
                  <>
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                    </span>
                    <span className="text-emerald-500 font-semibold">Running</span>
                  </>
                ) : (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    <span className="text-amber-500 font-semibold">Not detected:</span>
                  </>
                )}
              </div>
            )}

            {/* Setup hint with copy-paste commands */}
            {server.setupHint && (!server.healthUrl || mcpHealth[server.id] === false) && (
              <div className="rounded bg-muted/50 border border-border p-1.5 space-y-1">
                {server.setupHint.split('\n').map((line, i) => (
                  <div key={i} className="flex items-center gap-1 group">
                    <code className="flex-1 text-[10px] font-mono text-foreground select-all">{line}</code>
                    <button
                      type="button"
                      className={`shrink-0 text-[9px] transition-opacity duration-150 ${copiedCommand === line ? 'opacity-100 text-green-500 font-bold' : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary'}`}
                      title={copiedCommand === line ? 'Copied!' : 'Copy'}
                      onClick={() => {
                        navigator.clipboard.writeText(line)
                          .then(() => {
                            setCopiedCommand(line);
                            setTimeout(() => setCopiedCommand(null), 2000);
                          })
                          .catch(() => {});
                      }}
                    >
                      {copiedCommand === line ? '✓' : '📋'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Editable auth token */}
            <div className="space-y-1 pt-1.5">
              <input
                type="password"
                placeholder="Bearer token (optional)"
                value={mcpTokenEdits[server.id] !== undefined ? mcpTokenEdits[server.id] : (server.authToken || '')}
                onChange={e => setMcpTokenEdits(prev => ({ ...prev, [server.id]: e.target.value }))}
                onBlur={() => {
                  const val = mcpTokenEdits[server.id];
                  if (val === undefined) return;
                  persistMcp(mcpServers.map(x => x.id === server.id ? { ...x, authToken: val.trim() || undefined } : x));
                  setMcpTokenEdits(prev => { const n = { ...prev }; delete n[server.id]; return n; });
                }}
                className="w-full rounded border border-border bg-background px-2 py-1 text-[10px] font-mono placeholder:text-muted-foreground focus:outline-none focus:border-primary"
              />
            </div>

            {mcpStatus[server.id] && <div className="text-[10px] font-mono text-muted-foreground break-all">{mcpStatus[server.id]}</div>}
          </div>
        ))}
        <div className="flex gap-2">
          <Input value={mcpName} onChange={e => setMcpName(e.target.value)} placeholder="Name" className="rounded-lg w-1/3 text-xs" />
          <Input value={mcpUrl} onChange={e => setMcpUrl(e.target.value)} placeholder="http://localhost:3920/mcp" className="rounded-lg flex-1 text-xs" />
        </div>
        <Input
          type="password"
          value={mcpToken}
          onChange={e => setMcpToken(e.target.value)}
          placeholder="API key / bearer token (optional)"
          className="rounded-lg text-xs"
        />
        {mcpStatus._new && <p className="text-[10px] text-destructive font-mono">{mcpStatus._new}</p>}
        <Button variant="secondary" size="sm" onClick={addMcpServer} className="rounded-lg font-medium text-xs">Add server</Button>
        <p className="text-[10px] text-muted-foreground font-mono leading-normal">
          Supports HTTP endpoints only. Keys stay local.
        </p>
      </Section>

      {/* ── Storage ── */}
      <Section id="storage" title="Storage" subtitle="Local library & cross-device sync.">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-xs font-medium">Re-index library</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
                Re-chunks and re-embeds all local documents.
              </p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 h-8 text-[10px] rounded-lg font-medium"
              onClick={() => {
                if (!window.confirm('Re-chunk and re-embed all documents? Existing chat citations into old chunks will lose their exact highlight position.')) return;
                if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                  chrome.runtime.sendMessage({ action: 'REINDEX_LIBRARY' }, () => void chrome.runtime.lastError);
                }
              }}
            >
              Re-index
            </Button>
          </div>
          <div>
            <span className="text-xs font-medium">Stored in your browser</span>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-normal">
              All workspaces and files reside locally in browser IndexedDB.
            </p>
          </div>
          <Button variant="outline" size="sm" className="w-full mt-1 rounded-lg font-medium text-xs" onClick={exportWorkspace}>
            Export active workspace to a folder…
          </Button>

          <div className="flex items-center justify-between mt-4">
            <div>
              <span className="text-xs font-medium">Workspace Docs</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">Linked to the active workspace</p>
            </div>
            <span className="text-sm font-bold font-mono">{docCount}</span>
          </div>

          <div className="flex items-center justify-between mt-2">
            <div>
              <span className="text-xs font-medium">Global Library</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">All docs across workspaces</p>
            </div>
            <span className="text-sm font-bold font-mono">{globalDocCount}</span>
          </div>

          <div className="flex items-center justify-between mt-2 gap-3">
            <div className="min-w-0">
              <span className="text-xs font-medium">Clean up global library</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">Remove unlinked documents.</p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 h-8 text-[10px] rounded-lg font-medium"
              onClick={onCleanupOrphans}
            >
              Clean up
            </Button>
          </div>

          <div className="h-0.5 bg-border w-full my-4" />

          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Google Drive</span>
            {authed ? (
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground">
                <span className="w-1.5 h-1.5 rounded-full bg-background mr-1.5" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-muted px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Optional
              </span>
            )}
          </div>

          {authed && profile ? (
            <div className="flex items-center justify-between bg-muted/30 p-2 rounded-lg border border-border">
              <div className="flex items-center gap-2">
                {profile.picture && <img className="w-6 h-6 rounded-full border border-border" src={profile.picture} alt="" />}
                <span className="text-xs font-medium">{profile.email}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={logout} className="rounded-md font-medium text-xs">Sign out</Button>
            </div>
          ) : (
            <>
              <Button variant="outline" size="sm" className="w-full mt-2 rounded-lg font-medium text-xs" onClick={login}>
                Sign in with Google
              </Button>
              <p className="text-[10px] text-muted-foreground mt-1 leading-normal">
                Cross-device Google Drive workspace synchronization.
              </p>
            </>
          )}

          {authed && (
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Sync Folder Name</label>
                <Input
                  type="text"
                  value={folderName}
                  onChange={e => setFolderName(e.target.value)}
                  onBlur={saveSettings}
                  className="rounded-lg text-xs"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">Sync raw research sources</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={syncResearchSources}
                  onClick={() => {
                    setSyncResearchSources(!syncResearchSources);
                    setTimeout(saveSettings, 50);
                  }}
                  className={`shrink-0 w-10 h-5 border rounded-full transition-colors relative ${syncResearchSources ? 'bg-primary border-primary' : 'bg-muted border-border'}`}
                >
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-background transition-all ${syncResearchSources ? 'right-0.5' : 'left-0.5'}`} />
                </button>
              </div>

              <Button
                variant="outline"
                size="sm"
                className="w-full rounded-lg font-medium text-xs mt-1"
                onClick={forceResync}
              >
                Force Resync All
              </Button>
            </div>
          )}
      </Section>

    </div>
  );
};
