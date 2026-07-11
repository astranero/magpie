import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { get, set } from 'idb-keyval';
import { Edit2, Trash2, FileText, Library, MessageSquare, SlidersHorizontal } from 'lucide-react';
import { LocalDocument, Project, Chat, ChatMessage, ResearchPlan, ResolvedCitation, TabInfo, View } from './types';
import { LoreView } from './components/LoreView';
import { LinkPreview, LinkPreviewState } from './components/LinkPreview';
import { MagpieMark } from './components/BrandMark';

// Brand import moved to top level, removing here due to TS import rule
import { ChatView } from './components/ChatView';
import { SettingsView } from './components/SettingsView';
import { DocumentView } from './components/DocumentView';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { findPromptCommand, buildHelpText, loadCustomSkills, SlashCommand } from '../lib/commands';
import { contentHasTag } from '../lib/frontmatter';
import { timeAgo } from '../lib/format';
import { fileToDataUrl, collectDirectoryFiles, inlineRelativeImages } from '../lib/import-helpers';

// ── Helpers ──

function msg(action: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ action, ...data }, (res) => {
        resolve(res || { success: false, error: 'No response' });
      });
    } else {
      resolve({ success: false, error: 'Chrome API not available' });
    }
  });
}

/** Resolve citation markers in AI text against the chunk store (via the service worker) */
async function resolveCitations(text: string): Promise<ResolvedCitation[]> {
  const res = await msg('RESOLVE_CITATIONS', { text });
  if (res.success && Array.isArray(res.citations)) {
    return res.citations as ResolvedCitation[];
  }
  return [];
}

// ══════════════════════════════════════════════
// App Component
// ══════════════════════════════════════════════

export default function App() {
  const [view, setView] = useState<View>('lore');

// Brand import moved to top level, removing here due to TS import rule
  const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);

  // Capture
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Projects & Chats
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [activeChatId, setActiveChatId] = useState<string>('');

  // Inline editing state
  const [editingProjectId, setEditingProjectId] = useState<string>('');
  // Two-step inline confirm for workspace delete (avoids window.confirm)
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string>('');

  // Documents
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [globalDocuments, setGlobalDocuments] = useState<LocalDocument[]>([]);
  const [docCount, setDocCount] = useState(0);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [highlightAnchorId, setHighlightAnchorId] = useState<string | null>(null);

  // Settings
  const [customUrl, setCustomUrl] = useState('https://openrouter.ai/api/v1');
  const [customKey, setCustomKey] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [folderName, setFolderName] = useState('Magpie');

// Brand import moved to top level removed here due to top-level import restriction
  const [autoLinkCaptures, setAutoLinkCaptures] = useState(true);
  // Ephemeral page context: include the current tab's content in chat
  // without capturing it (persisted preference)
  const [includePageContext, setIncludePageContext] = useState(false);
  // Where to return when leaving DocumentView (citation chips open docs from
  // chat; source list opens them from sources), + chat reading position so
  // "back" lands on the message the user was reading, not the bottom.
  const docReturnViewRef = useRef<'lore' | 'chat'>('lore');
  const chatScrollTopRef = useRef<number | null>(null);
  const chatScrollToBottomRef = useRef<(() => void) | null>(null);
  const logBufferRef = useRef<Record<string, string[]>>({});
  const logFlushTimerRef = useRef<number | null>(null);
  // Live research synthesis stream (report tokens during [SYNTHESIZING])


  // User-defined slash commands (Settings → Custom Commands)
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  // Storage durability: the real guarantee for extensions is the
  // `unlimitedStorage` manifest permission (exempts our IndexedDB from
  // quota eviction). navigator.storage.persist() is a website API driven by
  // site-engagement heuristics — it routinely returns false for extension
  // pages, which is expected and NOT a problem, so no warning on false.
  useEffect(() => {
    navigator.storage?.persist?.().catch(() => {});
  }, []);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    loadCustomSkills().then(setCustomCommands);
    const onChange = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'customSkills' in changes) loadCustomSkills().then(setCustomCommands);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  // Drive
  const [authed, setAuthed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [profile, setProfile] = useState<{ name: string; email: string; picture: string } | null>(null);

  // Local File System
  const [localFolderName, setLocalFolderName] = useState<string | null>(null);

  // Chat
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [researching, setResearching] = useState<Record<string, boolean>>({});
  const [researchLogs, setResearchLogs] = useState<Record<string, string[]>>({});
  const msgEnd = useRef<HTMLDivElement>(null);
  const chatPortRef = useRef<chrome.runtime.Port | null>(null);

  // F3: buffer streamed deltas + flush once per animation frame.
  // Prevents per-token setMessages storms during long responses.
  const deltaBufferRef = useRef<{ chatId: string; assistantId: string; text: string } | null>(null);
  const rafPendingRef = useRef<number | null>(null);
  const flushDeltaBuffer = useCallback(() => {
    rafPendingRef.current = null;
    const buf = deltaBufferRef.current;
    if (!buf || !buf.text) return;
    const { chatId, assistantId, text } = buf;
    deltaBufferRef.current = { chatId, assistantId, text: '' };
    setMessages(prev => {
      const list = prev[chatId] || [];
      const idx = list.findIndex(x => x.id === assistantId);
      if (idx === -1) {
        return { ...prev, [chatId]: [...list, { id: assistantId, role: 'assistant', text, streaming: true }] };
      }
      const copy = [...list];
      copy[idx] = { ...copy[idx], text: copy[idx].text + text, streaming: true };
      return { ...prev, [chatId]: copy };
    });
  }, []);
  const pushDelta = useCallback((chatId: string, assistantId: string, text: string) => {
    if (!deltaBufferRef.current || deltaBufferRef.current.chatId !== chatId || deltaBufferRef.current.assistantId !== assistantId) {
      deltaBufferRef.current = { chatId, assistantId, text };
    } else {
      deltaBufferRef.current.text += text;
    }
    if (rafPendingRef.current == null) {
      rafPendingRef.current = requestAnimationFrame(flushDeltaBuffer);
    }
  }, [flushDeltaBuffer]);
  const flushDeltasNow = useCallback(() => {
    if (rafPendingRef.current != null) {
      cancelAnimationFrame(rafPendingRef.current);
      rafPendingRef.current = null;
    }
    flushDeltaBuffer();
  }, [flushDeltaBuffer]);
  /** Mark the streaming assistant message as done — flush + swap render mode. */
  const finalizeStreamingMessage = useCallback((chatId: string, assistantId: string) => {
    flushDeltasNow();
    setMessages(prev => {
      const list = prev[chatId] || [];
      const idx = list.findIndex(x => x.id === assistantId);
      if (idx === -1) return prev;
      const copy = [...list];
      copy[idx] = { ...copy[idx], streaming: false };
      return { ...prev, [chatId]: copy };
    });
  }, [flushDeltasNow]);

  // ──────── Tab Tracking ────────
  const refreshTabInfo = useCallback(() => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs?.[0];
        if (t && t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))) {
          setTabInfo({ title: t.title || 'Untitled', url: t.url, favIconUrl: t.favIconUrl });
        } else {
          setTabInfo(null);
        }
      });
    }
  }, []);

  // ── Link preview: follow links without leaving the panel ──
  const [linkPreview, setLinkPreview] = useState<LinkPreviewState | null>(null);

  const openLinkPreview = useCallback(async (url: string) => {
    setLinkPreview({ url, loading: true });
    const res = await msg('FETCH_URL_PREVIEW', { url });
    setLinkPreview(prev => {
      // A newer preview request replaced this one — don't clobber it
      if (!prev || prev.url !== url) return prev;
      return res.success !== false && res.markdown
        ? { url, title: res.title as string, markdown: res.markdown as string, loading: false }
        : { url, loading: false, error: (res.error as string) || 'Fetch failed' };
    });
  }, []);

  // Auto-name placeholder workspaces from the first meaningful signal (a
  // research topic or the first chat message). Only ever renames titles
  // that are still defaults — a name the user chose is never touched.
  const DEFAULT_TITLE_RE = /^(default session|session \d|new workspace|untitled)/i;
  const maybeAutoNameProject = useCallback(async (candidate: string) => {
    const project = projects.find(p => p.id === activeProjectId);
    if (!project || !DEFAULT_TITLE_RE.test(project.title.trim())) return;
    const title = candidate.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '').slice(0, 60);
    if (title.length < 4) return;
    await msg('UPDATE_PROJECT', { id: activeProjectId, title });
    await loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId]);

  // Clicking a link in chat/documents forwards the CURRENT tab there — the
  // page opens beside the panel, ready for the page-context toggle. The
  // in-panel preview stays available via /follow (and link-chaining inside
  // a preview); Cmd/Ctrl-click opens a fresh browser tab.
  const openLinkInTab = useCallback((url: string) => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs?.[0];
        if (t?.id != null) chrome.tabs.update(t.id, { url });
        else window.open(url, '_blank');
      });
    } else {
      window.open(url, '_blank');
    }
  }, []);

  const captureLinkPreview = useCallback(async () => {
    if (!linkPreview?.url || linkPreview.capturing) return;
    setLinkPreview(prev => prev ? { ...prev, capturing: true } : prev);
    const res = await msg('CAPTURE_URL', { url: linkPreview.url, projectId: activeProjectId });
    if (res.success !== false && res.docId) {
      setLinkPreview(prev => prev ? { ...prev, capturing: false, captured: true } : prev);
      showToast('success', res.isDuplicate
        ? 'Already in your library — linked to this workspace'
        : `✓ Captured: "${String(res.title || '').slice(0, 40)}"`);
      if (activeProjectId) loadDocuments(activeProjectId);
    } else {
      setLinkPreview(prev => prev ? { ...prev, capturing: false } : prev);
      showToast('error', (res.error as string) || 'Capture failed');
    }
  }, [linkPreview, activeProjectId]);

  // Update one message in a chat in place (used by the in-chat plan card)
  const updateMessage = useCallback((chatId: string, msgId: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages(prev => {
      const list = prev[chatId] || [];
      const idx = list.findIndex(x => x.id === msgId);
      if (idx === -1) return prev;
      const copy = [...list];
      copy[idx] = updater(copy[idx]);
      return { ...prev, [chatId]: copy };
    });
  }, []);

  useEffect(() => {
    refreshTabInfo();
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      const onActivated = () => refreshTabInfo();
      const onUpdated = (_tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (info.status === 'complete' || info.title || info.url) refreshTabInfo();
      };
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
      return () => {
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      };
    }
    return undefined;
  }, [refreshTabInfo]);

  // ──────── Init ────────
  useEffect(() => {
    loadProjects();
    loadSettings();
    trySilentAuth();

    get('ara-local-directory-handle').then(handle => {
      if (handle && handle.name) {
        setLocalFolderName(handle.name);
      }
    }).catch(console.error);

    const messageListener = (m: any) => {
      if (m.action === 'DEEP_RESEARCH_LOG') {
        // Batch log lines: buffer in a ref, flush every 300ms. A setState per
        // line re-rendered the entire panel for every scraped page.
        const buf = logBufferRef.current;
        (buf[m.projectId] ||= []).push(m.status);
        if (!logFlushTimerRef.current) {
          logFlushTimerRef.current = window.setTimeout(() => {
            logFlushTimerRef.current = null;
            const pending = logBufferRef.current;
            logBufferRef.current = {};
            setResearchLogs(prev => {
              const next = { ...prev };
              for (const [pid, lines] of Object.entries(pending)) {
                next[pid] = [...(next[pid] || []), ...lines].slice(-300);
              }
              return next;
            });
            setResearching(prev => {
              let changed = false;
              const next = { ...prev };
              for (const pid of Object.keys(pending)) {
                if (!next[pid]) { next[pid] = true; changed = true; }
              }
              return changed ? next : prev;
            });
          }, 300);
        }
      }

      if (m.action === 'DEEP_RESEARCH_DONE') {
        loadChatHistory(m.chatId);
        setResearching(prev => ({ ...prev, [m.projectId]: false }));

      }
    };

    // Restore research state persisted by the worker — the run survives the
    // panel closing, the worker dying, and even the browser restarting.
    msg('GET_RESEARCH_STATUS').then((res: any) => {
      const job = res?.job;
      if (res?.success && job) {
        if (Array.isArray(job.logs) && job.logs.length > 0) {
          setResearchLogs(prev => ({ ...prev, [job.projectId]: job.logs }));
        }
        if (res.running) {
          setResearching(prev => ({ ...prev, [job.projectId]: true }));
        }
      }
    }).catch(() => {});

    // Lifecycle port: tells the worker this window's panel is open, so the
    // toolbar icon can toggle open/close reliably.
    let lifecyclePort: chrome.runtime.Port | null = null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.connect && chrome.windows) {
      chrome.windows.getCurrent((w) => {
        if (typeof w?.id !== 'number') return;
        try {
          lifecyclePort = chrome.runtime.connect({ name: 'sidepanel-lifecycle' });
          lifecyclePort.postMessage({ type: 'OPEN', windowId: w.id });
        } catch { /* worker asleep — toggle degrades gracefully */ }
      });
    }

    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener(messageListener);
      return () => {
        chrome.runtime.onMessage.removeListener(messageListener);
        try { lifecyclePort?.disconnect(); } catch { /* already gone */ }
      };
    }
    return undefined;
  }, []);

  // ──────── Sync Across Windows ────────
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('ai_research_assistant_sync');
    channel.onmessage = (event) => {
      if (event.data === 'SYNC_STATE') {
        loadProjects();
        if (activeProjectId) {
          loadDocuments(activeProjectId);
          loadChats(activeProjectId);
        }
      }
    };
    return () => channel.close();
  }, [activeProjectId, activeChatId]);

  // ──────── Write documents to local folder when they change ────────
  useEffect(() => {
    if (!activeProjectId || documents.length === 0) return;

    (async () => {
      try {
        const handle = await get('ara-local-directory-handle');
        if (!handle) return;

        // @ts-ignore
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          if (!permissionWarnedRef.current) {
            permissionWarnedRef.current = true;
            showToast('error', 'Folder write access expired — re-pick the save folder in Config');
          }
          return;
        }

        const project = projects.find(p => p.id === activeProjectId);
        const rawTitle = project?.title || 'workspace';
        const dirName = rawTitle.trim()
          .normalize('NFC')
          .replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, '')
          .replace(/[^\w\s\-().,'!&+#@\[\]{}]/g, '')
          .replace(/\s+/g, ' ')
          .replace(/^\.+/, '')
          .replace(/\.+$/, '')
          .trim()
          .slice(0, 100) || 'workspace';

        // @ts-ignore
        const workspaceDir = await handle.getDirectoryHandle(dirName, { create: true });

        for (const doc of documents) {
          if (!doc.content) continue;
          // Machine-gathered research sources stay in the extension library
          // (citations resolve against them) but do NOT flood the user's .md
          // folder — a deep run captures 30-150 of them. The report and the
          // consolidated Research Sources list ARE mirrored.
          if (contentHasTag(doc.content, 'research-source')) continue;
          const cleanTitle = doc.title.trim()
            .normalize('NFC')
            .replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, '')
            .replace(/[^\w\s\-().,'!&+#@\[\]{}]/g, '')
            .replace(/\s+/g, ' ')
            .replace(/^\.+/, '')
            .replace(/\.+$/, '')
            .trim();
          const fileName = `${cleanTitle.slice(0, 100) || 'untitled'}.md`;
          try {
            // @ts-ignore
            const fileHandle = await workspaceDir.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(doc.content);
            await writable.close();
          } catch (fileErr) {
            console.warn(`[local-folder] Failed to write ${fileName}:`, fileErr);
          }
        }
      } catch (err) {
        console.error('[local-folder] Write pass failed:', err);
      }
    })();
  }, [documents, activeProjectId, projects]);

  // ──────── Async Import Progress (PDF + Images) ────────
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const importChannel = new BroadcastChannel('ai_research_assistant_import');
    importChannel.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'pdf-progress') {
        if (data.status === 'parsing') {
          showToast('success', `📄 Parsing: ${data.file}...`);
        } else if (data.status === 'done') {
          showToast('success', `✓ ${data.file} imported (${data.imported}/${data.total})`);
          if (activeProjectId) loadDocuments(activeProjectId);
        } else if (data.status === 'error') {
          showToast('error', `✗ ${data.file}: ${data.error}`);
        }
      } else if (data.type === 'pdf-complete') {
        showToast('success', `📄 PDF import complete: ${data.imported}/${data.total} imported`);
        if (activeProjectId) loadDocuments(activeProjectId);
      } else if (data.type === 'reindex-progress') {
        if (data.done % 5 === 0 || data.error) {
          showToast(data.error ? 'error' : 'success', data.error ? `✗ Re-index: ${data.title}: ${data.error}` : `♻️ Re-indexed ${data.done}/${data.total}`);
        }
      } else if (data.type === 'reindex-complete') {
        showToast('success', `♻️ Library re-indexed: ${data.done}/${data.total} documents`);
        if (activeProjectId) loadDocuments(activeProjectId);
      } else if (data.type === 'image-progress') {
        if (data.status === 'processing') {
          showToast('success', `🖼️ Analyzing: ${data.file}...`);
        } else if (data.status === 'done') {
          showToast('success', `✓ ${data.file} analyzed (${data.imported}/${data.total})`);
          if (activeProjectId) loadDocuments(activeProjectId);
        } else if (data.status === 'error') {
          showToast('error', `✗ ${data.file}: ${data.error}`);
        }
      } else if (data.type === 'image-complete') {
        showToast('success', `🖼️ Image import complete: ${data.imported}/${data.total} analyzed`);
        if (activeProjectId) loadDocuments(activeProjectId);
      }
    };
    return () => importChannel.close();
  }, [activeProjectId]);

  useEffect(() => {
    if (activeProjectId) {
      set('ara-active-project-id', activeProjectId).catch(console.error);
      loadDocuments(activeProjectId);
      loadChats(activeProjectId);
    }
  }, [activeProjectId]);

  // Load chat history whenever the active chat changes
  useEffect(() => {
    if (activeChatId) {
      loadChatHistory(activeChatId);
    }
  }, [activeChatId]);

  // Self-healing "researching" flag: DEEP_RESEARCH_DONE broadcasts can be
  // missed (panel closed, other window asleep), which left the field-log
  // card up forever. While ANY project shows researching, poll the worker
  // every 5s and clear flags for projects with no live run.
  useEffect(() => {
    const anyResearching = Object.values(researching).some(Boolean);
    if (!anyResearching) return;
    const check = () => {
      msg('GET_RESEARCH_STATUS').then((res: any) => {
        if (!res?.success) return;
        setResearching(prev => {
          const liveProject = res.running ? res.job?.projectId : null;
          let changed = false;
          const next = { ...prev };
          for (const pid of Object.keys(next)) {
            if (next[pid] && pid !== liveProject) { next[pid] = false; changed = true; }
          }
          return changed ? next : prev;
        });
      }).catch(() => {});
    };
    check();
    const interval = window.setInterval(check, 5000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.values(researching).some(Boolean)]);

  useEffect(() => {
    if (msgEnd.current) {
      // F4: instant scroll while generating; smooth when idle.
      msgEnd.current.scrollIntoView({ behavior: generating[activeChatId] ? 'auto' : 'smooth' });
    }
  }, [messages[activeChatId], generating[activeChatId]]);

  const loadProjects = async () => {
    const res = await msg('LIST_PROJECTS');
    if (res.success && Array.isArray(res.projects)) {
      const proj = res.projects as Project[];
      setProjects(proj);
      if (proj.length > 0) {
        if (!activeProjectId) setActiveProjectId(proj[0].id);
      } else {
        const createRes = await msg('CREATE_PROJECT', { title: 'Default Session' });
        if (createRes.success) {
          const newId = createRes.id as string;
          setProjects([{ id: newId, title: 'Default Session', createdAt: '', updatedAt: '' }]);
          setActiveProjectId(newId);
        }
      }
    }
  };

  const loadChats = async (projectId: string) => {
    const res = await msg('LIST_CHATS', { projectId });
    if (res.success && Array.isArray(res.chats)) {
      const ch = res.chats as Chat[];
      if (ch.length > 0) {
        if (!activeChatId || !ch.find(c => c.id === activeChatId)) setActiveChatId(ch[0].id);
      } else {
        setActiveChatId('');
      }
    }
  };

  const createNewProject = async () => {
    let title = tabInfo?.title;
    if (!title || title.trim() === '') {
      title = 'Session ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const res = await msg('CREATE_PROJECT', { title });
    if (res.success) {
      const newId = res.id as string;
      await loadProjects();
      setActiveProjectId(newId);
    }
  };



  const handleProjectRenameSubmit = async (newTitle: string) => {
    setEditingProjectId('');
    if (!activeProjectId || !newTitle || newTitle.trim() === '') return;
    const currentProject = projects.find(p => p.id === activeProjectId);
    if (!currentProject || newTitle.trim() === currentProject.title) return;
    
    await msg('UPDATE_PROJECT', { id: activeProjectId, title: newTitle.trim() });
    await loadProjects();
  };

  const deleteProject = async () => {
    if (!activeProjectId) return;

    // Two-step inline confirm: first click arms the confirm state,
    // second click within 3s executes. No window.confirm().
    if (confirmDeleteProjectId !== activeProjectId) {
      setConfirmDeleteProjectId(activeProjectId);
      setTimeout(() => setConfirmDeleteProjectId(''), 3000);
      return;
    }

    setConfirmDeleteProjectId('');
    await msg('DELETE_PROJECT', { id: activeProjectId });
    // Clear local state before reloading so the deleted project isn't selected
    setActiveProjectId('');
    setActiveChatId('');
    setDocuments([]);
    setMessages({});
    await loadProjects();
  };



  const loadDocuments = async (projectId: string) => {
    const res = await msg('LIST_DOCUMENTS', { projectId });
    if (res.success && Array.isArray(res.documents)) {
      setDocuments(res.documents as LocalDocument[]);
      setDocCount((res.documents as LocalDocument[]).length);
    }
    const globalRes = await msg('LIST_DOCUMENTS'); // Omitting projectId gets global list
    if (globalRes.success && Array.isArray(globalRes.documents)) {
      setGlobalDocuments(globalRes.documents as LocalDocument[]);
    }
  };

  const linkDocument = async (docId: string) => {
    if (!activeProjectId) return;
    await msg('LINK_DOCUMENT', { projectId: activeProjectId, docId });
    loadDocuments(activeProjectId);
  };

  const unlinkDocument = async (docId: string) => {
    if (!activeProjectId) return;
    await msg('UNLINK_DOCUMENT', { projectId: activeProjectId, docId });
    loadDocuments(activeProjectId);
  };

  const loadChatHistory = async (chatId: string) => {
    const res = await msg('GET_CHAT_HISTORY', { chatId });
    if (res.success && Array.isArray(res.messages)) {
      setMessages(prev => {
        // Plan cards live only in UI state — re-append pending ones so a
        // history reload (chat switch, research completion) doesn't eat a
        // draft the user is still negotiating.
        const pendingPlans = (prev[chatId] || []).filter(
          m => m.plan && (m.plan.status === 'draft' || m.plan.status === 'refining' || m.plan.status === 'loading')
        );
        const hist = (res.messages as any[]).length > 0
          ? (res.messages as ChatMessage[])
          : pendingPlans.length > 0 ? [] : [{ id: 'welcome', role: 'system' as const, text: 'Capture some web pages, then ask questions. Answers will cite your sources.' }];
        return { ...prev, [chatId]: [...hist, ...pendingPlans] };
      });
    }
  };

  const loadSettings = () => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(
        ['driveFolderName', 'customUrl', 'customKey', 'customModel', 'visionModel', 'autoLinkCaptures', 'includePageContext'],
        (r) => {
          if (r.driveFolderName) setFolderName(r.driveFolderName);
          if (r.customUrl) setCustomUrl(r.customUrl);
          if (r.customKey) setCustomKey(r.customKey);
          if (r.customModel) setCustomModel(r.customModel);
          if (r.visionModel) setVisionModel(r.visionModel);
          setAutoLinkCaptures(r.autoLinkCaptures !== false); // default ON
          setIncludePageContext(r.includePageContext === true); // default OFF
        }
      );
    }
  };

  const trySilentAuth = async () => {
    const res = await msg('GET_OAUTH_TOKEN_SILENT');
    if (res.success && res.token) {
      setAuthed(true);
      loadProfile(res.token as string);
    }
  };

  const loadProfile = (token: string) => {
    fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(d => {
        if (d.email) setProfile({ name: d.name || 'User', email: d.email, picture: d.picture || '' });
      })
      .catch(() => {});
  };

  // ──────── Actions ────────
  const showToast = (type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4000);
  };

  const pickLocalFolder = async () => {
    try {
      // Request readwrite HERE, inside the user gesture — later auto-saves
      // may not call requestPermission (Chrome requires user activation).
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await set('ara-local-directory-handle', handle);
      setLocalFolderName(handle.name);
      showToast('success', 'Local folder selected');
    } catch (err: any) {
      // AbortError = user dismissed the picker — not an error
      if (err?.name !== 'AbortError') {
        console.error('Failed to pick local folder:', err);
        showToast('error', 'Could not access folder — check browser permissions');
      }
    }
  };

  // Warn only once per session when write permission has lapsed
  const permissionWarnedRef = useRef(false);

  const writeDocToLocalFolder = async (doc: LocalDocument) => {
    try {
      // Same exclusion as the bulk mirror: scraped research sources never
      // land in the user's folder (report + sources list still do).
      if (doc.content && contentHasTag(doc.content, 'research-source')) return;
      const handle = await get('ara-local-directory-handle');
      if (handle) {
        // NOTE: never call requestPermission here — this runs after async
        // message roundtrips, so there is no user activation and Chrome
        // throws "User activation is required to request permissions".
        // @ts-ignore
        const hasPermission = await handle.queryPermission({ mode: 'readwrite' });
        if (hasPermission !== 'granted') {
          if (!permissionWarnedRef.current) {
            permissionWarnedRef.current = true;
            showToast('error', 'Folder write access expired — re-pick the save folder in Config');
          }
          return;
        }
        
        // Get the current project's title for the workspace subdirectory
        const project = projects.find(p => p.id === activeProjectId);
        const projectTitle = project?.title || 'Unnamed Workspace';
        const cleanProjectTitle = projectTitle.trim()
          .normalize('NFC')
          .replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, '')
          .replace(/[^\w\s\-().,'!&+#@\[\]{}]/g, '')
          .replace(/\s+/g, ' ')
          .replace(/^\.+/, '')
          .replace(/\.+$/, '')
          .trim()
          .slice(0, 100) || 'Unnamed Workspace';
        
        // Get or create the workspace subdirectory
        // @ts-ignore
        const workspaceDir = await handle.getDirectoryHandle(cleanProjectTitle, { create: true });
        
        // File System Access API is very strict about filenames.
        // Use an allowlist approach: keep only safe chars.
        const cleanTitle = doc.title.trim()
          .normalize('NFC')
          .replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, '')  // invisible unicode
          .replace(/[^\w\s\-().,'!&+#@\[\]{}]/g, '')                 // keep only safe chars
          .replace(/\s+/g, ' ')                                       // collapse whitespace
          .replace(/^\.+/, '')                                         // no leading dots
          .replace(/\.+$/, '')                                         // no trailing dots
          .trim();
        const fileName = `${cleanTitle.slice(0, 100) || 'untitled'}.md`;
        // @ts-ignore
        const fileHandle = await workspaceDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(doc.content);
        await writable.close();
      }
    } catch (err) {
      console.error('Failed to write doc to local folder', err);
    }
  };

  const capture = async () => {
    if (!tabInfo) { showToast('error', 'Navigate to a web page first'); return; }
    setCapturing(true);
    // No projectId: the worker saves to the global library and links to the
    // active workspace only when the auto-link setting is on.
    const res = await msg('CAPTURE_PAGE', {});
    setCapturing(false);
    if (res.success) {
      const where = res.linkedTo ? 'workspace' : 'library';
      showToast('success', `✓ Captured to ${where}: "${(res.title as string || '').slice(0, 40)}…" (${res.chunkCount} chunks)`);
      if (activeProjectId) loadDocuments(activeProjectId);
      const docRes = await msg('GET_DOCUMENT', { docId: res.docId });
      if (docRes.success && docRes.document) {
        writeDocToLocalFolder(docRes.document as LocalDocument);
      }
    } else {
      showToast('error', (res.error as string) || 'Capture failed');
    }
  };

  // ── Local .md import ──
  const [importing, setImporting] = useState(false);

  /** Import individual .md files (no folder context — remote images still render). */
  const importMarkdownFiles = async () => {
    try {
      // @ts-ignore — File System Access API
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }]
      });
      setImporting(true);
      const files: Array<{ name: string; content: string }> = [];
      for (const handle of handles) {
        const file: File = await handle.getFile();
        files.push({ name: file.name, content: await file.text() });
      }
      await sendImportedFiles(files);
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToast('error', 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  /** Import a folder: picks up all .md files and inlines their relative images. */
  const importMarkdownFolder = async () => {
    try {
      // @ts-ignore — File System Access API
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      setImporting(true);
      const filesByPath = await collectDirectoryFiles(dirHandle);
      const files: Array<{ name: string; content: string }> = [];
      for (const [path, handle] of filesByPath) {
        if (!/\.(md|markdown)$/i.test(path)) continue;
        const file: File = await handle.getFile();
        const raw = await file.text();
        const content = await inlineRelativeImages(raw, path, filesByPath);
        files.push({ name: file.name, content });
      }
      if (files.length === 0) {
        showToast('error', 'No .md files found in that folder');
        return;
      }
      await sendImportedFiles(files);
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToast('error', 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const sendImportedFiles = async (files: Array<{ name: string; content: string }>) => {
    if (!activeProjectId) { showToast('error', 'No active session'); return; }
    let imported = 0;
    const total = files.length;
    for (let i = 0; i < total; i++) {
      const file = files[i];
      showToast('success', `Importing Markdown ${i + 1}/${total}: ${file.name}...`);
      const res = await msg('IMPORT_LOCAL_MD', { projectId: activeProjectId, files: [file] }) as any;
      if (res.success && res.imported > 0) {
        imported++;
      }
    }
    showToast('success', `✓ Imported ${imported}/${total} markdown file(s)`);
    loadDocuments(activeProjectId);
  };

  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  /** Import local PDFs — parsed by code first, vision model only for scanned pages. */
  const importPdfFiles = async () => {
    try {
      // @ts-ignore — File System Access API
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]
      });
      if (!activeProjectId) { showToast('error', 'No active session'); return; }
      
      // Read all files to base64 first (this is fast)
      const files: Array<{ name: string; base64: string }> = [];
      for (const h of handles) {
        const file: File = await h.getFile();
        const base64 = await fileToBase64(file);
        files.push({ name: file.name, base64 });
      }

      showToast('success', `📄 Sending ${files.length} PDF(s) for background parsing...`);
      
      // Send all PDFs to the service worker — it processes them async and
      // notifies via BroadcastChannel. No await blocking the UI.
      msg('IMPORT_LOCAL_PDF', {
        projectId: activeProjectId,
        files
      });

      // Don't setImporting(true) — the UI stays responsive
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToast('error', 'PDF import failed');
    }
  };

  /** Import local images — turned into searchable text by the vision model. */
  const importImageFiles = async () => {
    try {
      // @ts-ignore — File System Access API
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'] } }]
      });
      if (!activeProjectId) { showToast('error', 'No active session'); return; }
      
      // Read all files to data URLs first (fast)
      const files: Array<{ name: string; dataUrl: string }> = [];
      for (const h of handles) {
        const file: File = await h.getFile();
        const dataUrl = await fileToDataUrl(file);
        files.push({ name: file.name, dataUrl });
      }

      showToast('success', `🖼️ Sending ${files.length} image(s) for background analysis...`);
      
      // Fire and forget — service worker processes async with BroadcastChannel progress
      msg('IMPORT_LOCAL_IMAGES', {
        projectId: activeProjectId,
        files
      });
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToast('error', 'Image import failed');
    }
  };

  const deleteDoc = async (id: string) => {
    // Optimistically remove from UI
    const removed = documents.find(d => d.id === id);
    setDocuments(prev => prev.filter(d => d.id !== id));
    setDocCount(prev => Math.max(0, prev - 1));

    await msg('DELETE_DOCUMENT', { docId: id });

    // Show undo toast — user has 5 seconds to reconsider
    // (After this window, the document is gone permanently)
    if (removed) {
      const undoToast = { type: 'success' as const, text: `Deleted "${removed.title.slice(0, 30)}" — reload to undo` };
      setToast(undoToast);
      setTimeout(() => setToast(t => t === undoToast ? null : t), 5000);
    }

    loadDocuments(activeProjectId);
  };

  const toggleDoc = async (id: string, enabled: boolean) => {
    setDocuments(prev => prev.map(d => d.id === id ? { ...d, enabled } : d));
    await msg('UPDATE_DOCUMENT_SELECTION', { docId: id, enabled });
    loadDocuments(activeProjectId);
  };

  const downloadDoc = (doc: LocalDocument) => {
    if (!doc.content) {
      showToast('error', 'Content not available for download.');
      return;
    }
    const blob = new Blob([doc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.title.replace(/[/\\?%*:|"<>]/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const login = async () => {
    const res = await msg('GET_OAUTH_TOKEN_INTERACTIVE');
    if (res.success && res.token) {
      setAuthed(true);
      loadProfile(res.token as string);
    }
  };

  const logout = async () => {
    await msg('CLEAR_OAUTH_TOKEN');
    setAuthed(false);
    setProfile(null);
  };

  const syncToDrive = async () => {
    setSyncing(true);
    const res = await msg('SYNC_TO_DRIVE');
    setSyncing(false);
    if (res.success) {
      showToast('success', `✓ Synced ${res.synced}/${res.total} documents to Drive`);
      loadDocuments(activeProjectId);
    } else {
      showToast('error', (res.error as string) || 'Sync failed');
    }
  };

  const importFromDrive = async () => {
    setSyncing(true);
    const res = await msg('IMPORT_FROM_DRIVE');
    setSyncing(false);
    if (res.success) {
      showToast('success', `✓ Imported ${res.imported} documents from Drive`);
      loadDocuments(activeProjectId);
    } else {
      showToast('error', (res.error as string) || 'Import failed');
    }
  };

  const saveSettings = () => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({
        driveFolderName: folderName,
        customUrl,
        customKey,
        customModel,
        visionModel,
        autoLinkCaptures,
        includePageContext   // was missing — ensure full state is persisted
      }, () => {
        // Silently save settings without toast
      });
    }
  };

  // ──────── Chat ────────

  const togglePageContext = () => {
    const next = !includePageContext;
    setIncludePageContext(next);
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ includePageContext: next });
    }
  };

  /** Stream a slash-command turn: labeled user message + systemPromptOverride. */
  const sendCommandOverStream = (userQuery: string, label: string, systemPrompt: string) => {
    const currentChatId = activeChatId;
    const commandMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text: `[${label}] ${userQuery}` };
    setMessages(prev => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []), commandMsg]
    }));
    setGenerating(prev => ({ ...prev, [currentChatId]: true }));

    const port = chrome.runtime.connect({ name: 'chat-stream' });
    chatPortRef.current = port;
    let finished = false;
    const assistantId = `${Date.now() + 1}`;

    const finish = () => {
      if (finished) return;
      finished = true;
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      if (chatPortRef.current === port) chatPortRef.current = null;
    };

    port.onMessage.addListener((m: any) => {
      if (m.type === 'DELTA') {
        pushDelta(currentChatId, assistantId, m.text);
      } else if (m.type === 'DONE' || m.type === 'ERROR') {
        finalizeStreamingMessage(currentChatId, assistantId);
        if (m.type === 'ERROR') {
          setMessages(prev => ({
            ...prev,
            [currentChatId]: [...(prev[currentChatId] || []), {
              id: `${Date.now() + 2}`,
              role: 'system' as const,
              text: (m.error as string) || 'Error — check Settings.'
            }]
          }));
        }
        finish();
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(finish);

    port.postMessage({
      type: 'START',
      chatId: currentChatId,
      projectId: activeProjectId,
      prompt: userQuery,
      systemPromptOverride: systemPrompt,
      includePageContext,
    });
  };

  const send = async () => {
    const text = input.trim();
    // Research running does NOT block chat — only an in-flight generation in
    // THIS chat does. Other chats (and this one) stay usable during research.
    if (!text || generating[activeChatId]) return;

    // ── Pending research plan: chat input drives the plan ──
    const draftPlanMsg = findDraftPlan(activeChatId);
    if (draftPlanMsg?.plan && !text.startsWith('/')) {
      const plan = draftPlanMsg.plan;
      if (plan.status === 'loading' || plan.status === 'refining') {
        showToast('error', 'Plan is still updating — one moment');
        return;
      }
      setInput('');
      if (/^(start|go|run|yes|confirm|start research|looks good|lgtm)[.!]?$/i.test(text)) {
        await executeDeepResearch(draftPlanMsg.id, plan);
      } else {
        await refineResearchPlan(draftPlanMsg, text);
      }
      return;
    }

    // /page <question> — one-shot: include the current page for this message
    // only, regardless of the toggle
    let messageText = text;
    let forcePageContext = false;
    if (text.toLowerCase().startsWith('/recall ')) {
      const topic = text.slice('/recall '.length).trim();
      if (!topic) { showToast('error', 'Please provide a topic after /recall'); return; }
      setInput('');
      const res = await msg('RECALL_DOCS', { query: topic, projectId: activeProjectId });
      const linked = (res.linked as Array<{ id: string; title: string; snippet: string }>) || [];
      const body = linked.length === 0
        ? `No relevant documents found in your Global Lore for "${topic}".`
        : `Pulled ${linked.length} document${linked.length === 1 ? '' : 's'} into this workspace — now available for chat:\n\n${linked.map(d => `- **${d.title}**${d.snippet ? `\n  …${d.snippet}…` : ''}`).join('\n')}`;
      setMessages(prev => ({
        ...prev,
        [activeChatId]: [...(prev[activeChatId] || []), { id: Date.now().toString(), role: 'system' as const, text: body }]
      }));
      if (linked.length > 0) loadDocuments(activeProjectId);
      return;
    }

    if (text.toLowerCase() === '/clear') {
      setInput('');
      clearChat();
      return;
    }

    // /follow <url> — preview a link inside the panel (capture optional)
    if (text.toLowerCase().startsWith('/follow ')) {
      let url = text.slice('/follow '.length).trim();
      if (!url) { showToast('error', 'Please provide a URL after /follow'); return; }
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      setInput('');
      openLinkPreview(url);
      return;
    }

    if (text.toLowerCase().startsWith('/page ')) {
      messageText = text.slice('/page '.length).trim();
      if (!messageText) {
        showToast('error', 'Please provide a question after /page');
        return;
      }
      forcePageContext = true;
    }

    if (text.toLowerCase().startsWith('/deepresearch ')) {
      const topic = text.slice('/deepresearch '.length).trim();
      if (!topic) {
        showToast('error', 'Please provide a topic after /deepresearch');
        return;
      }
      setInput('');
      await startDeepResearchCommand(topic, 'deep');
      return;
    }

    if (text.toLowerCase().startsWith('/research ')) {
      const topic = text.slice(10).trim();
      if (!topic) {
        showToast('error', 'Please provide a topic after /research');
        return;
      }
      setInput('');
      await startDeepResearchCommand(topic, 'quick');
      return;
    }

    // /create-skill [focus] — distill the workspace's research into a
    // reusable custom slash command (saved to Settings → Custom Commands)
    if (text.toLowerCase() === '/create-skill' || text.toLowerCase().startsWith('/create-skill ')) {
      const instruction = text.slice('/create-skill'.length).trim();
      setInput('');
      const currentChatId = activeChatId;
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), { id: Date.now().toString(), role: 'user', text }]
      }));
      setGenerating(prev => ({ ...prev, [currentChatId]: true }));
      const res = await msg('CREATE_SKILL', { projectId: activeProjectId, chatId: currentChatId, instruction });
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      const body = res.success !== false && res.cmd
        ? `**Skill created: \`${res.cmd}\`**\n\n${res.desc}\n\nUse it right away — type \`${res.cmd} <your question>\` in any chat. It's saved under Config → Custom Commands (edit or delete there), and a copy lives in Lore as **Skill: ${res.cmd}**.\n\n<details><summary>What the skill knows</summary>\n\n${res.systemPrompt}\n\n</details>`
        : `Skill creation failed: ${res.error || 'unknown error'}`;
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), { id: `${Date.now() + 1}`, role: 'system', text: body }]
      }));
      if (res.success !== false && res.cmd) loadDocuments(activeProjectId);
      return;
    }

    // /analyze works with or without an argument — it targets the whole workspace
    if (text.toLowerCase() === '/analyze' || text.toLowerCase().startsWith('/analyze ')) {
      const focus = text.slice('/analyze'.length).trim();
      setInput('');
      sendCommandOverStream(
        focus || 'Analyze the source documents in this workspace.',
        '📊 Workspace Analysis',
        'You are a research librarian analyzing a document collection. Using the provided sources, produce: ## Collection Overview (how many distinct sources/topics are represented), ## Topic Clusters (group the material into themes), ## Key Findings Per Cluster, ## Gaps & Unanswered Questions (what is missing or thin). Cite sources.'
      );
      return;
    }

    // ── Specialized slash commands ──
    // These inject a system prompt prefix to change how the AI responds


    // Check for /help command
    if (text.toLowerCase() === '/help') {
      setInput('');
      const helpText = buildHelpText(customCommands);
      setMessages(prev => ({
        ...prev,
        [activeChatId]: [...(prev[activeChatId] || []), {
          id: Date.now().toString(),
          role: 'system' as const,
          text: helpText
        }]
      }));
      return;
    }

    // Prompt-style slash commands come from the shared registry
    const matched = findPromptCommand(text, customCommands);
    if (matched) {
      if (!matched.query) {
        showToast('error', `Please provide a query after ${matched.command.cmd}`);
        return;
      }
      setInput('');
      sendCommandOverStream(matched.query, matched.command.label!, matched.command.systemPrompt!);
      return;
    }

    const currentChatId = activeChatId;
    const currentProjectId = activeProjectId;
    maybeAutoNameProject(messageText).catch(() => {});
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: forcePageContext ? `[📄 Current Page] ${messageText}` : messageText
    };
    const assistantId = `${Date.now() + 1}`;

    setMessages(prev => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []), userMsg]
    }));
    setInput('');
    setGenerating(prev => ({ ...prev, [currentChatId]: true }));

    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      return;
    }

    // Stream tokens over a long-lived port (also keeps the MV3 worker alive)
    const port = chrome.runtime.connect({ name: 'chat-stream' });
    chatPortRef.current = port;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      if (chatPortRef.current === port) chatPortRef.current = null;
    };

    port.onMessage.addListener((m: any) => {
      if (m?.type === 'DELTA') {
        pushDelta(currentChatId, assistantId, m.text);
      } else if (m?.type === 'DONE') {
        finalizeStreamingMessage(currentChatId, assistantId);
        finish();
        port.disconnect();
      } else if (m?.type === 'ERROR') {
        finalizeStreamingMessage(currentChatId, assistantId);
        setMessages(prev => ({
          ...prev,
          [currentChatId]: [...(prev[currentChatId] || []), {
            id: `${Date.now() + 2}`,
            role: 'system',
            text: (m.error as string) || 'Error — check Settings.'
          }]
        }));
        finish();
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(finish);

    port.postMessage({
      type: 'START',
      prompt: messageText,
      chatId: currentChatId,
      projectId: currentProjectId,
      includePageContext: includePageContext || forcePageContext
    });
  };

  const clearChat = async () => {
    if (!activeChatId) return;
    await msg('CLEAR_CHAT_HISTORY', { chatId: activeChatId });
    setMessages(prev => ({
      ...prev,
      [activeChatId]: [{
        id: 'welcome',
        role: 'system',
        text: 'Chat cleared. Ask a new question about your research, or type /research <topic> to start deep research.'
      }]
    }));
  };

  /**
   * /research and /deepresearch: post the command + a live plan card into the
   * chat. The user refines the plan by talking to it (normal input while a
   * draft is pending), then starts it from the card.
   */
  const startDeepResearchCommand = async (topic: string, mode: 'quick' | 'deep' = 'quick') => {
    if (!activeProjectId || !activeChatId) return;
    const currentChatId = activeChatId;
    const planMsgId = `plan-${Date.now()}`;

    setMessages(prev => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []),
        { id: Date.now().toString(), role: 'user', text: `${mode === 'deep' ? '/deepresearch' : '/research'} ${topic}` },
        {
          id: planMsgId, role: 'assistant', text: '',
          plan: { topic, effectiveTopic: topic, subQuestions: [], mode, status: 'loading' }
        }
      ]
    }));

    try {
      const preview = await msg('PREVIEW_DEEP_RESEARCH', {
        projectId: activeProjectId, chatId: currentChatId, topic, mode
      });
      updateMessage(currentChatId, planMsgId, m => ({
        ...m,
        plan: {
          ...m.plan!,
          effectiveTopic: (preview.effectiveTopic as string) || topic,
          subQuestions: (preview.subQuestions as string[]) || [],
          status: 'draft'
        }
      }));
    } catch {
      // Preview failed — show the raw topic, still startable
      updateMessage(currentChatId, planMsgId, m => ({ ...m, plan: { ...m.plan!, status: 'draft' } }));
    }
  };

  /** Find the pending (draft/refining) plan card in a chat, newest first. */
  const findDraftPlan = (chatId: string): ChatMessage | undefined =>
    [...(messages[chatId] || [])].reverse().find(m => m.plan && (m.plan.status === 'draft' || m.plan.status === 'refining' || m.plan.status === 'loading'));

  /** Chat-driven plan refinement: user feedback → revised topic + questions. */
  const refineResearchPlan = async (planMsg: ChatMessage, feedback: string) => {
    const currentChatId = activeChatId;
    const plan = planMsg.plan!;
    setMessages(prev => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []), { id: Date.now().toString(), role: 'user', text: feedback }]
    }));
    updateMessage(currentChatId, planMsg.id, m => ({ ...m, plan: { ...m.plan!, status: 'refining' } }));

    const res = await msg('REFINE_RESEARCH_PLAN', {
      effectiveTopic: plan.effectiveTopic,
      subQuestions: plan.subQuestions,
      feedback
    });

    if (res.success !== false && res.effectiveTopic) {
      updateMessage(currentChatId, planMsg.id, m => ({
        ...m,
        plan: {
          ...m.plan!,
          effectiveTopic: res.effectiveTopic as string,
          subQuestions: (res.subQuestions as string[]) || m.plan!.subQuestions,
          status: 'draft'
        }
      }));
    } else {
      updateMessage(currentChatId, planMsg.id, m => ({ ...m, plan: { ...m.plan!, status: 'draft' } }));
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), {
          id: `${Date.now() + 1}`, role: 'system',
          text: `Couldn't apply that change (${res.error || 'no revision returned'}). The plan is unchanged — try rephrasing, or press Start.`
        }]
      }));
    }
  };

  const cancelResearchPlan = (planMsgId: string) => {
    updateMessage(activeChatId, planMsgId, m => ({ ...m, plan: { ...m.plan!, status: 'cancelled' } }));
  };

  const executeDeepResearch = async (planMsgId: string, plan: ResearchPlan) => {
    if (!activeProjectId || !activeChatId) return;

    updateMessage(activeChatId, planMsgId, m => ({ ...m, plan: { ...m.plan!, status: 'started' } }));
    setResearching(prev => ({ ...prev, [activeProjectId]: true }));
    setResearchLogs(prev => ({ ...prev, [activeProjectId]: [] }));
    maybeAutoNameProject(plan.effectiveTopic).catch(() => {});

    const currentChatId = activeChatId;

    const researchRes = await msg('START_DEEP_RESEARCH', {
      projectId: activeProjectId,
      chatId: currentChatId,
      topic: plan.effectiveTopic,
      mode: plan.mode
    });

    if (!researchRes.success) {
      // Failed to start or failed mid-run — DEEP_RESEARCH_DONE won't fire
      setResearching(prev => ({ ...prev, [activeProjectId]: false }));
      showToast('error', `Research failed: ${researchRes.error}`);
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), {
          id: `${Date.now()}`, role: 'system', text: `Research failed: ${researchRes.error}`
        }]
      }));
      return;
    }

    // setResearching(false) handled by DEEP_RESEARCH_DONE handler
    setResearchLogs(prev => ({
      ...prev,
      [activeProjectId]: [...(prev[activeProjectId] || []), '[SUCCESS] Deep research complete — results added to chat.']
    }));
    showToast('success', 'Deep research complete!');
    loadDocuments(activeProjectId);
    const docsRes = await msg('LIST_DOCUMENTS', { projectId: activeProjectId });
    if (docsRes.success && Array.isArray(docsRes.documents)) {
      for (const d of docsRes.documents) {
        await writeDocToLocalFolder(d as LocalDocument);
      }
    }
  };

  const cancelTask = async () => {
    if (generating[activeChatId]) {
      // Disconnecting the stream port aborts generation in the worker
      chatPortRef.current?.disconnect();
      chatPortRef.current = null;
      await msg('CANCEL_TASK', { chatId: activeChatId });
      setGenerating(prev => ({ ...prev, [activeChatId]: false }));
    }
    if (researching[activeProjectId]) {
      await msg('CANCEL_TASK', { projectId: activeProjectId });
      setResearching(prev => ({ ...prev, [activeProjectId]: false }));
    }
  };

  // ══════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════
  return (
    <div className="h-screen w-full flex flex-col bg-background text-foreground overflow-hidden">
      
      {/* ── Functional Header (Topic) ── */}
      {view !== 'settings' && (
        <header className="card-rule flex items-center px-4 py-3 bg-card gap-3 shrink-0">
          <MagpieMark size={17} className="shrink-0 text-foreground" />
          <span className="text-xs font-mono font-bold text-muted-foreground uppercase tracking-widest" title="Magpie — your research collector">Workspace</span>
          {editingProjectId ? (
            <input
              autoFocus
              type="text"
              className="flex h-8 w-full border-2 border-primary bg-background px-2 text-sm font-mono focus-visible:outline-none"
              defaultValue={projects.find(p => p.id === activeProjectId)?.title || ''}
              onBlur={(e) => handleProjectRenameSubmit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleProjectRenameSubmit(e.currentTarget.value);
                if (e.key === 'Escape') setEditingProjectId('');
              }}
            />
          ) : (
            <div className="flex items-center flex-1 min-w-0 gap-1 bg-background border-2 border-border hover:border-primary transition-colors focus-within:border-primary">
              <Select
                value={activeProjectId || ''}
                onValueChange={(val) => {
                  if (!val) return;
                  if (val === 'new') createNewProject();
                  else setActiveProjectId(val as string);
                }}
              >
                <SelectTrigger className="h-8 border-none shadow-none bg-transparent hover:bg-transparent focus:ring-0 p-0 px-2 truncate w-full text-sm font-bold font-mono uppercase tracking-wide">
                  <SelectValue placeholder="Select a topic...">
                    {projects.find(p => p.id === activeProjectId)?.title || "Select a topic..."}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="border-2 border-border rounded-md shadow-card">
                  {projects.map(p => (
                    <SelectItem key={p.id} value={p.id} className="font-mono rounded-md uppercase text-xs font-bold">{p.title}</SelectItem>
                  ))}
                  <SelectSeparator className="bg-border" />
                  <SelectItem value="new" className="text-primary font-bold font-mono rounded-md uppercase text-xs">+ New Workspace</SelectItem>
                </SelectContent>
              </Select>
              {activeProjectId && (
                <button className="text-muted-foreground hover:text-primary shrink-0 p-2" onClick={() => setEditingProjectId(activeProjectId)} title="Rename Workspace">
                  <Edit2 size={14} />
                </button>
              )}
              {activeProjectId && projects.length > 1 && (
                <button
                  className={`shrink-0 px-2 py-1 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors border-2 ${
                    confirmDeleteProjectId === activeProjectId
                      ? 'border-destructive text-destructive bg-destructive/10 hover:bg-destructive hover:text-destructive-foreground'
                      : 'border-transparent text-muted-foreground hover:text-destructive'
                  }`}
                  onClick={deleteProject}
                  title={confirmDeleteProjectId === activeProjectId ? 'Click again to confirm delete' : 'Delete Workspace'}
                  aria-label={confirmDeleteProjectId === activeProjectId ? 'Confirm workspace deletion' : 'Delete workspace'}
                >
                  {confirmDeleteProjectId === activeProjectId ? 'DELETE?' : <Trash2 size={14} />}
                </button>
              )}
            </div>
          )}
        </header>
      )}

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col overflow-hidden relative bg-background border-b border-border">
        {toast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-primary text-primary-foreground text-xs font-bold uppercase tracking-widest animate-in slide-in-from-top-2 border-2 border-primary shadow-card">
            {toast.text}
          </div>
        )}

        {/* Tab Context for Sources View */}
        {view === 'lore' && tabInfo && (
          <div className="flex items-center gap-3 p-3 border-b border-border bg-muted/40 shrink-0">
            {tabInfo.favIconUrl ? (
              <img src={tabInfo.favIconUrl} className="w-4 h-4 object-contain grayscale opacity-80" alt="" />
            ) : (
              <div className="w-4 h-4 flex items-center justify-center text-muted-foreground">
                <FileText size={14} />
              </div>
            )}
            <div className="text-sm truncate font-medium flex-1 text-foreground font-mono">{tabInfo.title}</div>
            <Button size="sm" onClick={capture} disabled={capturing} variant="default" className="shrink-0 h-8 text-xs rounded-md border-2 border-primary uppercase font-bold tracking-wider">
              {capturing ? 'CAPTURING...' : 'CAPTURE'}
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-hidden flex flex-col relative p-2">
          <div className={`flex-1 min-h-0 flex-col overflow-hidden ${view === 'lore' ? 'flex' : 'hidden'}`}>
            <LoreView 
              documents={documents}
              globalDocuments={globalDocuments}
              authed={authed}
              syncing={syncing}
              toggleDoc={toggleDoc}
              downloadDoc={downloadDoc}
              deleteDoc={deleteDoc}
              linkDocument={linkDocument}
              unlinkDocument={unlinkDocument}
              syncToDrive={syncToDrive}
              importFromDrive={importFromDrive}
              importing={importing}
              importMarkdownFiles={importMarkdownFiles}
              importMarkdownFolder={importMarkdownFolder}
              importPdfFiles={importPdfFiles}
              importImageFiles={importImageFiles}
              timeAgo={timeAgo}
              onDocumentClick={async (id, anchorId) => {
                docReturnViewRef.current = 'lore';
                // Search hits can point at docs outside the loaded lists
                const exists = documents.find(d => d.id === id) || globalDocuments.find(d => d.id === id);
                if (!exists) {
                  const res = await msg('GET_DOCUMENT', { docId: id });
                  if (res.success && res.document) {
                    setGlobalDocuments(prev => [...prev, res.document as LocalDocument]);
                  }
                }
                setActiveDocumentId(id);
                setHighlightAnchorId(anchorId || null);
                setView('document');
              }}
            />
          </div>

          {view === 'document' && (
            <DocumentView 
              document={documents.find(d => d.id === activeDocumentId) || globalDocuments.find(d => d.id === activeDocumentId) || null}
              highlightAnchorId={highlightAnchorId}
              onBack={() => {
                setActiveDocumentId(null);
                setHighlightAnchorId(null);
                setView(docReturnViewRef.current);
              }}
              timeAgo={timeAgo}
              onOpenExternalLink={openLinkInTab}
            />
          )}

          <div className={`flex-1 min-h-0 flex-col overflow-hidden ${view === 'chat' ? 'flex' : 'hidden'}`}>
            <ChatView 
              messages={messages[activeChatId] || []}
              input={input}
              setInput={setInput}
              send={send}
              clearChat={clearChat}
              cancelTask={cancelTask}
              activeChatId={activeChatId}
              activeProjectId={activeProjectId}
              generating={generating}
              researching={researching}
              isActive={view === 'chat'}
              
              researchLogs={researchLogs}
              documents={documents}
              resolveCitations={resolveCitations}
              pageContextEnabled={includePageContext}
              pageContextTitle={tabInfo?.title ?? null}
              onTogglePageContext={togglePageContext}
              scrollPosRef={chatScrollTopRef}
              scrollToBottomRef={chatScrollToBottomRef}
              customCommands={customCommands}
              onStartPlan={(msgId, plan) => executeDeepResearch(msgId, plan)}
              onCancelPlan={cancelResearchPlan}
              onOpenExternalLink={openLinkInTab}

              onOpenDocument={async (docId, anchorId) => {
                // If doc is not in current lists, fetch it to globalDocuments so DocumentView can display it
                const exists = documents.find(d => d.id === docId) || globalDocuments.find(d => d.id === docId);
                if (!exists) {
                  const res = await msg('GET_DOCUMENT', { docId });
                  if (res.success && res.document) {
                    setGlobalDocuments(prev => [...prev, res.document as LocalDocument]);
                  }
                }
                docReturnViewRef.current = 'chat';
                setActiveDocumentId(docId);
                setHighlightAnchorId(anchorId || null);
                setView('document');
              }}
            />
          </div>

          {view === 'settings' && (
            <SettingsView 
              customUrl={customUrl}
              setCustomUrl={setCustomUrl}
              customKey={customKey}
              setCustomKey={setCustomKey}
              customModel={customModel}
              setCustomModel={setCustomModel}
              visionModel={visionModel}
              setVisionModel={setVisionModel}
              customModels={customModels}
              fetchCustomModels={async () => {
                const res = await msg('FETCH_CUSTOM_MODELS', { url: customUrl, apiKey: customKey });
                if (res.success) {
                  setCustomModels(res.models as string[]);
                  if ((res.models as string[]).length > 0 && !customModel) setCustomModel((res.models as string[])[0]);
                } else showToast('error', (res.error as string) || 'Failed to fetch custom models');
              }}
              docCount={docCount}
              globalDocCount={globalDocuments.length}
              onCleanupOrphans={async () => {
                const res = await msg('CLEANUP_ORPHANS');
                if (res.success) {
                  const n = res.deleted as number;
                  showToast('success', n > 0 ? `Removed ${n} unlinked document${n === 1 ? '' : 's'} from library` : 'No unlinked documents found');
                  if (activeProjectId) loadDocuments(activeProjectId);
                } else showToast('error', (res.error as string) || 'Cleanup failed');
              }}
              authed={authed}
              profile={profile}
              login={login}
              logout={logout}
              folderName={folderName}
              setFolderName={setFolderName}
              localFolderName={localFolderName}
              pickLocalFolder={pickLocalFolder}
              autoLinkCaptures={autoLinkCaptures}
              setAutoLinkCaptures={(v) => {
                setAutoLinkCaptures(v);
                if (typeof chrome !== 'undefined' && chrome.storage) {
                  chrome.storage.local.set({ autoLinkCaptures: v });
                }
              }}
              saveSettings={saveSettings}
            />
          )}
        </div>
      </main>

      {/* ── Link preview overlay — follow links without leaving the panel ── */}
      {linkPreview && (
        <LinkPreview
          preview={linkPreview}
          onClose={() => setLinkPreview(null)}
          onCapture={captureLinkPreview}
          onFollow={openLinkPreview}
        />
      )}

      {/* ── Bottom Navigation Bar ── */}
      <nav className="flex items-center justify-between px-3 py-2.5 bg-card border-t border-border shrink-0">
        {([
          { key: 'lore' as View, label: 'Lore', Icon: Library, onClick: () => setView('lore') },
          { key: 'chat' as View, label: 'Chat', Icon: MessageSquare, onClick: () => { chatScrollTopRef.current = null; setView('chat'); chatScrollToBottomRef.current?.(); } },
          { key: 'settings' as View, label: 'Config', Icon: SlidersHorizontal, onClick: () => setView('settings') },
        ]).map(({ key, label, Icon, onClick }, i) => (
          <Fragment key={key}>
            {i > 0 && <div className="w-px h-4 bg-border mx-2" />}
            <button
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold font-mono tracking-widest uppercase transition-colors rounded-md border-2 relative ${
                view === key ? 'border-primary/25 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              onClick={onClick}
              aria-current={view === key ? 'page' : undefined}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
              {key === 'chat' && researching[activeProjectId] && (
                <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" title="Research running" aria-label="Research running" />
              )}
            </button>
          </Fragment>
        ))}
      </nav>
    </div>
  );
}
