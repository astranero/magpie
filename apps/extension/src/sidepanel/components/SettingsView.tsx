import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Section } from './Section';
import { CustomSkill, sanitizeCustomSkill } from '../../lib/commands';
import { McpServerConfig, McpConnection, getMcpServers, saveMcpServers } from '../../lib/mcp-client';
import { SearchApiKeys, getSearchApiKeys, saveSearchApiKeys } from '../../lib/search-providers';

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
  localFolderName: string | null;
  folderPermission?: 'granted' | 'expired' | null;
  pickLocalFolder: () => void;
  autoLinkCaptures: boolean;
  setAutoLinkCaptures: (val: boolean) => void;
  saveSettings: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  customUrl, setCustomUrl, customKey, setCustomKey, customModel, setCustomModel, visionModel, setVisionModel, customModels, fetchCustomModels,
  docCount, globalDocCount, onCleanupOrphans, authed, profile, login, logout, folderName, setFolderName, localFolderName, folderPermission, pickLocalFolder,
  autoLinkCaptures, setAutoLinkCaptures, saveSettings
}) => {

  // Research settings are self-contained: read/write chrome.storage directly.
  const [researchDepth, setResearchDepth] = useState<'standard' | 'deep' | 'exhaustive'>('standard');
  const [sourceQuality, setSourceQuality] = useState<'all' | 'high'>('all');
  const [academicDepth, setAcademicDepth] = useState<'abstract' | 'full'>('full');
  const [contextTokens, setContextTokens] = useState('32768');
  const [s2ApiKey, setS2ApiKey] = useState('');
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    chrome.storage.local.get(['researchDepth', 'contextTokens', 's2ApiKey', 'sourceQuality', 'academicDepth']).then(r => {
      if (r.researchDepth === 'deep' || r.researchDepth === 'exhaustive') setResearchDepth(r.researchDepth);
      if (r.sourceQuality === 'high') setSourceQuality('high');
      if (r.academicDepth === 'abstract') setAcademicDepth('abstract');
      if (r.contextTokens) setContextTokens(String(r.contextTokens));
      if (r.s2ApiKey) setS2ApiKey(r.s2ApiKey);
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
    (['tavily', 'brave', 'serper'] as const).forEach(k => {
      const v = (searchKeys[k] || '').trim();
      if (v) clean[k] = v;
    });
    saveSearchApiKeys(clean).catch(() => {});
  };
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({});
  useEffect(() => { getMcpServers().then(setMcpServers); }, []);
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
    } catch (e: any) {
      setMcpStatus(prev => ({ ...prev, [server.id]: `🔴 ${e.message}` }));
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
      {/* ── Custom Provider ── */}
      <Section id="provider" title="AI Provider Configuration" subtitle="Connect to any OpenAI-compatible API.">
          <div className="space-y-1.5">
            <label className="text-xs font-bold font-mono uppercase tracking-widest">Base URL</label>
            <Input 
              type="text" 
              placeholder="https://openrouter.ai/api/v1" 
              value={customUrl} 
              onChange={e => setCustomUrl(e.target.value)} 
              onBlur={saveSettings}
              className="border-2 rounded-md font-mono"
            />
          </div>
          
          <div className="space-y-1.5">
            <label className="text-xs font-bold font-mono uppercase tracking-widest">API Key</label>
            <Input 
              type="password" 
              placeholder="sk-..." 
              value={customKey} 
              onChange={e => setCustomKey(e.target.value)} 
              onBlur={saveSettings}
              className="border-2 rounded-md font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold font-mono uppercase tracking-widest">Model</label>
            <div className="flex gap-2">
              {customModels.length > 0 ? (
                <Select value={customModel} onValueChange={v => { setCustomModel(v as string); setTimeout(saveSettings, 0); }}>
                  <SelectTrigger className="flex-1 w-full border-2 rounded-md font-mono">
                    <SelectValue placeholder="Select a model..." />
                  </SelectTrigger>
                  <SelectContent className="border-2 rounded-md font-mono">
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
                  className="border-2 rounded-md font-mono"
                />
              )}
              <Button variant="secondary" onClick={fetchCustomModels} className="rounded-md border-2 font-bold font-mono uppercase">Fetch</Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold font-mono uppercase tracking-widest">Vision Model</label>
            <p className="text-[10px] text-muted-foreground font-mono">Used to read images & scanned PDFs. Leave blank to reuse the text model.</p>
            <div className="flex gap-2">
              {customModels.length > 0 ? (
                <Select value={visionModel} onValueChange={v => { setVisionModel(v as string); setTimeout(saveSettings, 0); }}>
                  <SelectTrigger className="flex-1 w-full border-2 rounded-md font-mono">
                    <SelectValue placeholder="Select a vision model..." />
                  </SelectTrigger>
                  <SelectContent className="border-2 rounded-md font-mono">
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
                  className="border-2 rounded-md font-mono"
                />
              )}
              <Button variant="secondary" onClick={fetchCustomModels} className="rounded-md border-2 font-bold font-mono uppercase">Fetch</Button>
            </div>
          </div>
      </Section>

      {/* ── Capture Behavior ── */}
      <Section id="capture" title="Capture" subtitle="Where new captures land.">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-xs font-bold font-mono uppercase tracking-widest">Auto-add to active workspace</span>
            <p className="text-[10px] text-muted-foreground font-mono mt-1 leading-normal">
              ON: captures are linked to the current workspace. OFF: captures only go to the Global Library — add them to a workspace manually.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoLinkCaptures}
            onClick={() => setAutoLinkCaptures(!autoLinkCaptures)}
            className={`shrink-0 w-12 h-6 border-2 transition-colors relative ${autoLinkCaptures ? 'bg-primary border-primary' : 'bg-muted border-border'}`}
            title="Toggle auto-add captures"
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-background transition-all ${autoLinkCaptures ? 'right-0.5' : 'left-0.5'}`} />
          </button>
        </div>
      </Section>

      {/* ── Research ── */}
      <Section id="research" title="Research" subtitle="Deep research scale and academic sources.">
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Research depth</label>
          <Select value={researchDepth} onValueChange={(v) => { setResearchDepth(v as any); saveResearchSetting({ researchDepth: v }); }}>
            <SelectTrigger className="w-full border-2 rounded-md font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-2 border-border rounded-md shadow-card">
              <SelectItem value="standard" className="font-mono text-xs">Standard — ~30 sources, fastest</SelectItem>
              <SelectItem value="deep" className="font-mono text-xs">Deep — ~80 sources, 2-3× slower</SelectItem>
              <SelectItem value="exhaustive" className="font-mono text-xs">Exhaustive — ~150 sources, 10+ min</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Scales web, academic (Semantic Scholar, HuggingFace, CrossRef) and news pipelines for /research and /deepresearch.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Source quality</label>
          <Select value={sourceQuality} onValueChange={(v) => { setSourceQuality(v as any); saveResearchSetting({ sourceQuality: v }); }}>
            <SelectTrigger className="w-full border-2 rounded-md font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-2 border-border rounded-md shadow-card">
              <SelectItem value="all" className="font-mono text-xs">All sources — broad coverage, includes blogs/forums</SelectItem>
              <SelectItem value="high" className="font-mono text-xs">High-authority only — journals, standards bodies, cited papers</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            High-authority keeps only reputable domains, DOI/arXiv links, and papers with ≥10 citations (or from the last year). "All" casts wider — useful for niche topics thin on formal literature.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Academic paper depth</label>
          <Select value={academicDepth} onValueChange={(v) => { setAcademicDepth(v as any); saveResearchSetting({ academicDepth: v }); }}>
            <SelectTrigger className="w-full border-2 rounded-md font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-2 border-border rounded-md shadow-card">
              <SelectItem value="abstract" className="font-mono text-xs">Abstracts only — fast, stable, ~2 chunks per paper</SelectItem>
              <SelectItem value="full" className="font-mono text-xs">Full text — richer but slower, may crash on very long PDFs</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Full text adds experimental detail, related work, and exact results — highest quality synthesis. Abstracts are a fallback if your machine crashes on long PDFs (each full paper = 15–30 chunks).
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Model context window (tokens)</label>
          <Input
            type="number"
            min={2048}
            step={1024}
            value={contextTokens}
            onChange={e => setContextTokens(e.target.value)}
            onBlur={() => saveResearchSetting({ contextTokens: Math.max(2048, Number(contextTokens) || 32768) })}
            className="border-2 rounded-md font-mono"
          />
          <p className="text-[10px] text-muted-foreground font-mono leading-normal">
            Report synthesis packs as much evidence as fits this window. Set to your model's real context size (Ollama default is often 8192).
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Semantic Scholar API key (optional)</label>
          <Input
            type="password"
            placeholder="Higher rate limits for the academic agent"
            value={s2ApiKey}
            onChange={e => setS2ApiKey(e.target.value)}
            onBlur={() => saveResearchSetting({ s2ApiKey: s2ApiKey.trim() })}
            className="border-2 rounded-md font-mono"
          />
        </div>
      </Section>

      {/* ── Custom Commands ── */}
      <Section id="skills" title="Custom Commands" subtitle="Your own slash commands with custom prompts." defaultOpen={false}>
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
                  className="shrink-0 text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground hover:text-destructive"
                  onClick={() => persistSkills(customSkills.filter(x => x.cmd !== sk.cmd))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Trigger</label>
          <Input value={newCmd} onChange={e => setNewCmd(e.target.value)} placeholder="/competitors" className="border-2 rounded-md font-mono" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Description</label>
          <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Research the competitive landscape" className="border-2 rounded-md font-mono" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-bold font-mono uppercase tracking-widest">Prompt</label>
          <textarea
            value={newPrompt}
            onChange={e => setNewPrompt(e.target.value)}
            placeholder="You are a competitive analyst. For the user's topic, identify direct competitors, positioning, strengths and weaknesses…"
            rows={4}
            className="w-full rounded-md border-2 border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
        </div>
        {skillError && <p className="text-[10px] text-destructive font-mono">{skillError}</p>}
        <Button variant="secondary" onClick={addSkill} className="rounded-md border-2 font-bold font-mono uppercase">Add command</Button>
        <p className="text-[10px] text-muted-foreground font-mono leading-normal">
          Custom commands run over your workspace lore with citations, exactly like /brief or /challenge.
        </p>
      </Section>

      {/* ── Research APIs ── */}
      <Section id="research-apis" title="Research APIs" subtitle="Link your own search APIs — agents use them first." defaultOpen={false}>
        {([
          ['tavily', 'Tavily', 'tvly-…'],
          ['brave', 'Brave Search', 'BSA…'],
          ['serper', 'Serper (Google)', '40-char key']
        ] as const).map(([id, label, ph]) => (
          <div key={id} className="space-y-1.5">
            <label className="text-xs font-bold font-mono uppercase tracking-widest">{label}</label>
            <Input
              type="password"
              value={searchKeys[id] || ''}
              onChange={e => setSearchKey(id, e.target.value)}
              onBlur={persistSearchKeys}
              placeholder={ph}
              className="border-2 rounded-md font-mono"
            />
          </div>
        ))}
        <p className="text-[10px] text-muted-foreground font-mono leading-normal">
          With a key set, /research and /deepresearch search through that provider instead of scraping DuckDuckGo — cleaner results, no anti-bot failures. Tried in the order listed; first configured provider wins. Keys stay in local extension storage and are only sent to the provider itself.
        </p>
      </Section>

      {/* ── MCP Servers ── */}
      <Section id="mcp" title="MCP Servers" subtitle="External tools over Streamable HTTP — used by deep research." defaultOpen={false}>
        {mcpServers.map(server => (
          <div key={server.id} className="rounded-md border border-border bg-background p-2 space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold font-mono truncate">{server.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">{server.url}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={server.enabled}
                title={server.enabled ? 'Enabled — research may call this server' : 'Disabled'}
                onClick={() => persistMcp(mcpServers.map(x => x.id === server.id ? { ...x, enabled: !x.enabled } : x))}
                className={`shrink-0 w-10 h-5 border-2 rounded-full transition-colors relative ${server.enabled ? 'bg-primary border-primary' : 'bg-muted border-border'}`}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-background transition-all ${server.enabled ? 'right-0.5' : 'left-0.5'}`} />
              </button>
              <button
                type="button"
                className="shrink-0 text-[10px] font-mono font-bold uppercase text-muted-foreground hover:text-primary"
                onClick={() => testMcpServer(server)}
              >
                Test
              </button>
              <button
                type="button"
                className="shrink-0 text-[10px] font-mono font-bold uppercase text-muted-foreground hover:text-destructive"
                onClick={() => persistMcp(mcpServers.filter(x => x.id !== server.id))}
              >
                Remove
              </button>
            </div>
            {mcpStatus[server.id] && <div className="text-[10px] font-mono text-muted-foreground break-all">{mcpStatus[server.id]}</div>}
          </div>
        ))}
        <div className="flex gap-2">
          <Input value={mcpName} onChange={e => setMcpName(e.target.value)} placeholder="Name" className="border-2 rounded-md font-mono w-1/3" />
          <Input value={mcpUrl} onChange={e => setMcpUrl(e.target.value)} placeholder="http://localhost:3920/mcp" className="border-2 rounded-md font-mono flex-1" />
        </div>
        <Input
          type="password"
          value={mcpToken}
          onChange={e => setMcpToken(e.target.value)}
          placeholder="API key / bearer token (optional)"
          className="border-2 rounded-md font-mono"
        />
        {mcpStatus._new && <p className="text-[10px] text-destructive font-mono">{mcpStatus._new}</p>}
        <Button variant="secondary" onClick={addMcpServer} className="rounded-md border-2 font-bold font-mono uppercase">Add server</Button>
        <p className="text-[10px] text-muted-foreground font-mono leading-normal">
          Extensions can't launch stdio MCP servers — run the server yourself and register its HTTP endpoint here.
          Enabling a server permits deep research to call its search-like tools with your topic.
        </p>
      </Section>

      {/* ── Storage ── */}
      <Section id="storage" title="Storage" subtitle="Manage local documents and sync.">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-xs font-bold font-mono uppercase tracking-widest">Re-index library</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-1 leading-normal">
                Re-chunks every document with the current pipeline (noise/table filters) and generates missing embeddings. Old chat citations into re-chunked docs will show as "position not found".
              </p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 h-8 text-[10px] rounded-md border-2 font-mono font-bold uppercase tracking-widest"
              onClick={() => {
                if (!window.confirm('Re-chunk and re-embed all documents? Existing chat citations into old chunks will lose their exact highlight position.')) return;
                if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                  chrome.runtime.sendMessage({ action: 'REINDEX_LIBRARY' });
                }
              }}
            >
              Re-index
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold font-mono uppercase tracking-widest">Local Storage</span>
            {localFolderName ? (
              folderPermission === 'expired' ? (
                <span className="inline-flex items-center rounded-md border border-highlight px-2.5 py-0.5 text-[10px] uppercase tracking-widest font-bold text-amber-700 dark:text-highlight">
                  <span className="w-1.5 h-1.5 rounded-full bg-current mr-1.5" /> {localFolderName} — permission expired
                </span>
              ) : (
                <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-[10px] uppercase tracking-widest font-bold bg-primary text-primary-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-background mr-1.5" /> {localFolderName}
                </span>
              )
            ) : (
              <span className="inline-flex items-center rounded-md border border-muted px-2.5 py-0.5 text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
                NONE SELECTED
              </span>
            )}
          </div>
          {folderPermission === 'expired' && (
            <p className="text-[10px] font-mono text-amber-700 dark:text-highlight leading-normal">
              Chrome expired write access to this folder — nothing is being saved to disk.
              Click the button below to re-grant it.
            </p>
          )}
          
          <Button variant="outline" size="sm" className="w-full mt-2 rounded-md border-2 font-bold font-mono uppercase text-xs" onClick={pickLocalFolder}>
            {localFolderName ? 'Change Save Folder' : 'Choose Local Save Folder'}
          </Button>

          {localFolderName && (
            <p className="text-[10px] text-muted-foreground font-mono uppercase mt-1 leading-normal">
              * Note: Chrome security prevents opening the OS file explorer directly. You can find and open files manually inside your "{localFolderName}" folder.
            </p>
          )}

          <div className="flex items-center justify-between mt-4">
            <div>
              <span className="text-xs font-bold font-mono uppercase tracking-widest">Workspace Docs</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">Documents linked to the active workspace</p>
            </div>
            <span className="text-sm font-bold font-mono">{docCount}</span>
          </div>

          <div className="flex items-center justify-between mt-2">
            <div>
              <span className="text-xs font-bold font-mono uppercase tracking-widest">Global Library</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">All docs across all workspaces</p>
            </div>
            <span className="text-sm font-bold font-mono">{globalDocCount}</span>
          </div>

          <div className="flex items-center justify-between mt-2 gap-3">
            <div className="min-w-0">
              <span className="text-xs font-bold font-mono uppercase tracking-widest">Clean up global library</span>
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5 leading-normal">Remove documents not linked to any workspace. Use when switching topics or after deleting a workspace.</p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 h-8 text-[10px] rounded-md border-2 font-mono font-bold uppercase tracking-widest"
              onClick={onCleanupOrphans}
            >
              Clean up
            </Button>
          </div>

          <div className="h-0.5 bg-border w-full my-4" />

          <div className="flex items-center justify-between">
            <span className="text-xs font-bold font-mono uppercase tracking-widest">Google Drive</span>
            {authed ? (
              <span className="inline-flex items-center border-2 px-2.5 py-0.5 text-[10px] uppercase tracking-widest font-bold bg-primary text-primary-foreground">
                <span className="w-1.5 h-1.5 bg-background mr-1.5" /> CONNECTED
              </span>
            ) : (
              <span className="inline-flex items-center border-2 border-muted px-2.5 py-0.5 text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
                OPTIONAL
              </span>
            )}
          </div>

          {authed && profile ? (
            <div className="flex items-center justify-between bg-muted/30 p-2 border-2 border-border">
              <div className="flex items-center gap-2">
                {profile.picture && <img className="w-6 h-6 border-2 border-primary grayscale" src={profile.picture} alt="" />}
                <span className="text-xs font-bold font-mono">{profile.email}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={logout} className="rounded-md font-bold font-mono uppercase text-xs">Sign out</Button>
            </div>
          ) : (
            <>
              <Button variant="outline" size="sm" className="w-full mt-2 rounded-md border-2 font-bold font-mono uppercase text-xs" onClick={login}>
                Sign in to Sync
              </Button>
              <p className="text-[10px] text-muted-foreground font-mono mt-1 leading-normal">
                Drive sync requires OAuth configuration. See the extension README for setup instructions.
              </p>
            </>
          )}

          {authed && (
            <div className="space-y-1.5 pt-2">
              <label className="text-xs font-bold font-mono uppercase tracking-widest">Sync Folder Name</label>
              <Input
                type="text"
                value={folderName}
                onChange={e => setFolderName(e.target.value)}
                onBlur={saveSettings}
                className="border-2 rounded-md font-mono"
              />
            </div>
          )}
      </Section>

    </div>
  );
};
