import { detectProviders, pickOllamaModel, OLLAMA_OPENAI_URL, BUILTIN_GEMINI_SENTINEL, type DetectedProviders } from '../../lib/provider-detect';
import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Section } from './Section';
import { CustomSkill, sanitizeCustomSkill } from '../../lib/commands';
import { McpServerConfig, McpConnection, getMcpServers, saveMcpServers } from '../../lib/mcp-client';
import { SearchApiKeys, getSearchApiKeys, saveSearchApiKeys } from '../../lib/search-providers';
import { getCrashLog, clearCrashLog, formatCrashLog } from '../../lib/crash-log';

interface SettingsViewProps {
  customUrl: string;
  setCustomUrl: (val: string) => void;
  customKey: string;
  setCustomKey: (val: string) => void;
  customModel: string;
  setCustomModel: (val: string) => void;
  visionModel: string;
  setVisionModel: (val: string) => void;
  customModels: string[];
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
  workspaceName: string;
  workspaceRules: string;
  saveWorkspaceRules: (rules: string) => void | Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  customUrl, setCustomUrl, customKey, setCustomKey, customModel, setCustomModel, visionModel, setVisionModel, customModels, fetchCustomModels,
  docCount, globalDocCount, onCleanupOrphans, authed, profile, login, logout, folderName, setFolderName, exportWorkspace,
  autoLinkCaptures, setAutoLinkCaptures, saveSettings, workspaceName, workspaceRules, saveWorkspaceRules
}) => {
  // Local draft of the workspace instructions; persisted on blur.
  const [rulesDraft, setRulesDraft] = useState(workspaceRules);
  useEffect(() => { setRulesDraft(workspaceRules); }, [workspaceRules]);

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
  const [detected, setDetected] = useState<DetectedProviders | null>(null);
  useEffect(() => { detectProviders().then(setDetected).catch(() => {}); }, []);
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
    (['tavily', 'brave', 'serper', 'jina'] as const).forEach(k => {
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
        if (!srv.healthUrl) continue;
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
    if (!/^https?:\/\//.test(url)) {
      setMcpStatus(prev => ({ ...prev, _new: 'URL must start with http:// or https://' }));
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

  // Auto-save when these values change and the component unmounts
  useEffect(() => {
    return () => {
      saveSettings();
    };
  }, [customUrl, customKey, customModel, visionModel, folderName, saveSettings]);

  return (
    <div className="flex-1 overflow-y-auto no-scrollbar p-4 space-y-6">
      {/* ── Workspace instructions ── */}
      <Section id="workspace-rules" title="Workspace Instructions" subtitle={`Persistent context for "${workspaceName}" — added to every prompt.`}>
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

      {/* ── Custom Provider ── */}
      <Section id="provider" title="AI Provider Configuration" subtitle="Configure your AI backend.">
          {detected && (detected.ollama.available || detected.builtinGemini.available) && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 space-y-2">
              <div className="text-[10px] font-semibold text-primary uppercase tracking-wider">Detected Local Options</div>
              {detected.ollama.available && (
                <button
                  type="button"
                  className="w-full text-left rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:border-primary transition-colors flex flex-col"
                  onClick={() => {
                    const model = pickOllamaModel(detected.ollama.models);
                    setCustomUrl(OLLAMA_OPENAI_URL); setCustomModel(model); setCustomKey('');
                    setTimeout(saveSettings, 0);
                  }}
                >
                  <span className="font-semibold">Use Ollama</span>
                  <span className="text-[10px] text-muted-foreground">Local model {detected.ollama.models.length ? `(${pickOllamaModel(detected.ollama.models)})` : ''} — fully offline.</span>
                </button>
              )}
              {detected.builtinGemini.available && (
                <button
                  type="button"
                  className="w-full text-left rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:border-primary transition-colors flex flex-col"
                  onClick={() => {
                    setCustomUrl(BUILTIN_GEMINI_SENTINEL); setCustomModel('gemini-nano'); setCustomKey('');
                    setTimeout(saveSettings, 0);
                  }}
                >
                  <span className="font-semibold">Use Built-in Gemini</span>
                  <span className="text-[10px] text-muted-foreground">On-device nano model — zero key setup.</span>
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
            <div className="flex gap-2">
              {customModels.length > 0 ? (
                <Select value={customModel} onValueChange={v => { setCustomModel(v as string); setTimeout(saveSettings, 0); }}>
                  <SelectTrigger className="flex-1 w-full rounded-lg text-xs">
                    <SelectValue placeholder="Select a model..." />
                  </SelectTrigger>
                  <SelectContent className="rounded-lg">
                    {customModels.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    {!customModels.includes(customModel) && customModel && <SelectItem value={customModel}>{customModel}</SelectItem>}
                  </SelectContent>
                </Select>
              ) : (
                <Input 
                  type="text" 
                  placeholder="google/gemini-2.5-flash" 
                  value={customModel} 
                  onChange={e => setCustomModel(e.target.value)} 
                  onBlur={saveSettings}
                  className="rounded-lg text-xs"
                />
              )}
              <Button variant="secondary" size="sm" onClick={fetchCustomModels} className="rounded-lg font-medium text-xs">Fetch</Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Vision Model</label>
            <div className="flex gap-2">
              {customModels.length > 0 ? (
                <Select value={visionModel} onValueChange={v => { setVisionModel(v as string); setTimeout(saveSettings, 0); }}>
                  <SelectTrigger className="flex-1 w-full rounded-lg text-xs">
                    <SelectValue placeholder="Select a vision model..." />
                  </SelectTrigger>
                  <SelectContent className="rounded-lg">
                    <SelectItem value=" ">— Use Text Model —</SelectItem>
                    {customModels.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    {!customModels.includes(visionModel) && visionModel && <SelectItem value={visionModel}>{visionModel}</SelectItem>}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type="text"
                  placeholder="google/gemini-2.5-flash"
                  value={visionModel}
                  onChange={e => setVisionModel(e.target.value)}
                  onBlur={saveSettings}
                  className="rounded-lg text-xs"
                />
              )}
              <Button variant="secondary" size="sm" onClick={fetchCustomModels} className="rounded-lg font-medium text-xs">Fetch</Button>
            </div>
            <p className="text-[10px] text-muted-foreground font-mono">Used for reading images & scanned PDFs (uses text model if blank).</p>
          </div>
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
                autoLinkCaptures ? 'translate-x-4.5' : 'translate-x-0.5'
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
            <span className="text-xs font-medium">Search the web when nothing matches</span>
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">
              Query search engines if your workspace and open page can't answer.
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
                webFallback ? 'translate-x-4.5' : 'translate-x-0.5'
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
                jinaEnabled ? 'translate-x-4.5' : 'translate-x-0.5'
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
              <SelectItem value="standard" className="font-mono text-xs">Standard — ~30 sources</SelectItem>
              <SelectItem value="deep" className="font-mono text-xs">Deep — ~80 sources</SelectItem>
              <SelectItem value="exhaustive" className="font-mono text-xs">Exhaustive — ~150 sources</SelectItem>
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
          ['jina', 'Jina (s.jina.ai)', 'jina_…']
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
            {server.healthUrl && (
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
            <div className="space-y-1.5 pt-2">
              <label className="text-xs font-medium">Sync Folder Name</label>
              <Input
                type="text"
                value={folderName}
                onChange={e => setFolderName(e.target.value)}
                onBlur={saveSettings}
                className="rounded-lg text-xs"
              />
            </div>
          )}
      </Section>

    </div>
  );
};
