import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { get, set } from 'idb-keyval';

// Collision-free message ids. `Date.now()` and `Date.now()+1` for a paired
// user+assistant bubble collide whenever the clock ticks between the two reads,
// so the assistant's streamed deltas land in the USER bubble (answer shows up
// inside the question). A monotonic per-mint counter guarantees distinctness
// while staying sortable/ordered.
let _uidSeq = 0;
const uid = (): string => `m${Date.now().toString(36)}${(_uidSeq++).toString(36)}`;

// Keep one path segment (folder or filename stem) safe across OSes.
const sanitizeSegment = (name: string): string =>
  (name || '')
    .normalize('NFC')
    .replace(/[‎‏​‌‍﻿]/g, '')
    .replace(/[^\w\s\-().,'!&+#@\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '').replace(/\.+$/, '')
    .trim()
    .slice(0, 100);
import { Edit2, Trash2, FileText, Library, MessageSquare, SlidersHorizontal } from 'lucide-react';
import { LocalDocument, Project, Chat, ChatMessage, ResearchPlan, ResolvedCitation, TabInfo, View } from './types';
import { LoreView } from './components/LoreView';
import { LinkPreview, LinkPreviewState } from './components/LinkPreview';

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
  // Chat is the first-run default; after that the panel reopens on whatever
  // view it was closed in (restored below — 'document' is transient, so its
  // return view is what gets remembered instead).
  const [view, setView] = useState<View>('chat');

  // Restore the last view once on mount, then persist every stable change.
  useEffect(() => {
    get('ara-last-view').then((v) => {
      if (v === 'lore' || v === 'chat' || v === 'settings') setView(v);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (view === 'lore' || view === 'chat' || view === 'settings') {
      set('ara-last-view', view).catch(() => {});
    }
  }, [view]);

// Brand import moved to top level, removing here due to TS import rule
  const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);

  // Capture
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

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
  // Stop fires DONE from BOTH the force-clear and the live run's finally;
  // dedupe the pair so the user sees one toast, not two.
  const doneGuardRef = useRef<Record<string, number>>({});
  // Live research synthesis: report tokens stream in during [SYNTHESIZING] and
  // render as markdown live. Which chat the report belongs to (projectId→chatId,
  // set at start), a per-project text buffer, and one throttle timer.
  // Chat questions queued behind an active research run (per chat), drained in
  // order when the run finishes. A ref so the once-registered DONE listener
  // always calls the freshest drain closure.
  const queuedRef = useRef<Record<string, Array<{ id: string; text: string; forcePageContext: boolean; projectId: string }>>>({});
  const drainQueueRef = useRef<(projectId: string) => void>(() => {});


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
    // Capture the timezone HERE (a real document reliably reports it) so the
    // service worker — which can report "UTC" — has a trustworthy location hint
    // for weather / "near me" answers.
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) chrome.storage.local.set({ araTimezone: tz });
    } catch { /* ignore */ }
    // Adopt the active session another sidepanel instance switched to, so two
    // windows show the same project AND chat. Stored as ONE pair so the chat id
    // can never be applied without its project — that inconsistency was what
    // leaked a stale chat into a freshly-created session. loadChats corrects an
    // adopted chat that isn't in the project.
    const adopt = (s: any) => {
      if (!s || typeof s !== 'object') return;
      // Record what we're adopting so the resulting state change doesn't echo a
      // redundant write back to storage.
      if (typeof s.projectId === 'string' && s.projectId && typeof s.chatId === 'string' && s.chatId) {
        lastSessionJsonRef.current = JSON.stringify({ projectId: s.projectId, chatId: s.chatId });
      }
      if (typeof s.projectId === 'string' && s.projectId) setActiveProjectId(prev => (prev === s.projectId ? prev : s.projectId));
      if (typeof s.chatId === 'string' && s.chatId) setActiveChatId(prev => (prev === s.chatId ? prev : s.chatId));
    };
    chrome.storage.local.get(['araActiveSession']).then((r: any) => adopt(r.araActiveSession));
    const onChange = (changes: Record<string, any>, area: string) => {
      if (area !== 'local') return;
      if ('customSkills' in changes) loadCustomSkills().then(setCustomCommands);
      if ('araActiveSession' in changes) adopt(changes.araActiveSession?.newValue);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  // When this instance becomes visible again, re-pull the current session's
  // content/status from the shared source (DB + worker) — another instance may
  // have advanced the chat or a research run while we were hidden.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) return;
      // Don't reload a chat we're mid-answer on — it would drop the streaming
      // message / the optimistic question.
      if (activeChatId && !streamingChatsRef.current.has(activeChatId) && !mirrorStreamRef.current[activeChatId]) {
        loadChatHistory(activeChatId).then(() => resumeMirror(activeChatId));
      }
      if (activeProjectId) loadDocuments(activeProjectId);
      msg('GET_RESEARCH_STATUS').then((res: any) => {
        const job = res?.job;
        if (res?.success && job) {
          if (Array.isArray(job.logs) && job.logs.length) setResearchLogs(prev => ({ ...prev, [job.projectId]: job.logs }));
          if (res.running) setResearching(prev => ({ ...prev, [job.projectId]: true }));
        }
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [activeProjectId, activeChatId]);

  // Drive
  const [authed, setAuthed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [profile, setProfile] = useState<{ name: string; email: string; picture: string } | null>(null);

  // Chat
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  // Live phase line for the thinking indicator ("Reading the page…")
  const [thinkingStatus, setThinkingStatus] = useState<Record<string, string>>({});
  const [researching, setResearching] = useState<Record<string, boolean>>({});
  const [researchLogs, setResearchLogs] = useState<Record<string, string[]>>({});
  const msgEnd = useRef<HTMLDivElement>(null);
  const chatPortRef = useRef<chrome.runtime.Port | null>(null);
  // Chats THIS instance is actively streaming — so a CHAT_STATE broadcast from
  // the background (which echoes to us too) doesn't fight our own live stream.
  const streamingChatsRef = useRef<Set<string>>(new Set());
  // Last active-session pair we wrote/adopted, so an adopt→setState→effect cycle
  // doesn't re-publish the same value (chrome.storage.set fires onChanged even
  // when the value is unchanged).
  const lastSessionJsonRef = useRef<string>('');
  // When another instance is answering, this maps chatId → the local assistant
  // message id we're streaming its broadcast tokens into (live mirror).
  const mirrorStreamRef = useRef<Record<string, string>>({});

  // F3: buffer streamed deltas + flush once per animation frame.
  // Prevents per-token setMessages storms during long responses.
  const deltaBufferRef = useRef<{ chatId: string; assistantId: string; text: string } | null>(null);
  const rafPendingRef = useRef<number | null>(null);
  // Assistant messages that have been finalized. A delta flush scheduled via
  // requestAnimationFrame can fire AFTER a DONE handler already cleared the
  // streaming flag (rAF is throttled when the panel is occluded, so the flush
  // lands late) — and would re-set streaming:true, leaving the blinking caret
  // and the raw-markdown fast-path stuck forever. Any flush for an id in this
  // set forces streaming:false, so finalization can never be undone.
  const finalizedIdsRef = useRef<Set<string>>(new Set());
  const flushDeltaBuffer = useCallback(() => {
    rafPendingRef.current = null;
    const buf = deltaBufferRef.current;
    if (!buf || !buf.text) return;
    const { chatId, assistantId, text } = buf;
    deltaBufferRef.current = { chatId, assistantId, text: '' };
    // Never re-open a message the DONE handler already finalized (late rAF).
    const stillStreaming = !finalizedIdsRef.current.has(`${chatId}::${assistantId}`);
    setMessages(prev => {
      const list = prev[chatId] || [];
      const idx = list.findIndex(x => x.id === assistantId);
      if (idx === -1) {
        return { ...prev, [chatId]: [...list, { id: assistantId, role: 'assistant', text, streaming: stillStreaming }] };
      }
      const copy = [...list];
      copy[idx] = { ...copy[idx], text: copy[idx].text + text, streaming: stillStreaming };
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
  /** Clear a streaming message's text mid-flight (worker sent RESET — e.g. a
   *  refusal is being replaced by a web-sourced answer). Drops any buffered
   *  deltas for it so the replacement starts clean. */
  const resetStreamingMessage = useCallback((chatId: string, assistantId: string) => {
    if (deltaBufferRef.current && deltaBufferRef.current.chatId === chatId && deltaBufferRef.current.assistantId === assistantId) {
      deltaBufferRef.current.text = '';
    }
    setMessages(prev => {
      const list = prev[chatId] || [];
      const idx = list.findIndex(x => x.id === assistantId);
      if (idx === -1) return prev;
      const copy = [...list];
      copy[idx] = { ...copy[idx], text: '', streaming: true };
      return { ...prev, [chatId]: copy };
    });
  }, []);

  /** Mark the streaming assistant message as done — flush + swap render mode. */
  const finalizeStreamingMessage = useCallback((chatId: string, assistantId: string) => {
    // Record BEFORE flushing so the flush itself (which may create or extend
    // the message) already writes streaming:false, and any later stray flush
    // stays false too. Bounded cleanup — ids accrete one per turn.
    if (finalizedIdsRef.current.size > 200) finalizedIdsRef.current.clear();
    finalizedIdsRef.current.add(`${chatId}::${assistantId}`);
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
        const next: TabInfo | null =
          t && t.url && (t.url.startsWith('http://') || t.url.startsWith('https://'))
            ? { title: t.title || 'Untitled', url: t.url, favIconUrl: t.favIconUrl }
            : null;
        // Bail when nothing changed. onUpdated fires many times per page load
        // (one per sub-resource), and a fresh object each time would re-render
        // the whole App on every tick — needless churn that shows as a flash /
        // jank when switching pages. Only setState on a real change.
        setTabInfo(prev => {
          if (prev === next) return prev;
          if (prev && next && prev.url === next.url && prev.title === next.title && prev.favIconUrl === next.favIconUrl) return prev;
          return next;
        });
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
      // Debounce: a live page (Gmail's unread counter, an SPA, a playing video)
      // fires onUpdated many times a second — each changes the title, so a raw
      // refresh would re-render the whole panel on every tick and, on a busy
      // mail tab, churn it into a freeze. Collapse bursts into one trailing
      // refresh, and ignore updates that aren't for the ACTIVE tab.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; refreshTabInfo(); }, 300);
      };
      const onActivated = () => schedule();
      const onUpdated = (_tabId: number, info: chrome.tabs.TabChangeInfo, tab?: chrome.tabs.Tab) => {
        if (!tab?.active) return; // background-tab noise — not our current page
        if (info.status === 'complete' || info.title || info.url) schedule();
      };
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onUpdated.addListener(onUpdated);
      return () => {
        if (timer) clearTimeout(timer);
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

    const messageListener = (m: any) => {
      if (m.action === 'CHAT_STATE') {
        // Another instance is (or just finished) answering in this chat — mirror
        // it LIVE. Ignore our own stream (we render it via the port).
        if (streamingChatsRef.current.has(m.chatId)) return;
        if (m.generating) {
          // Show the question now and open a local assistant message that the
          // CHAT_DELTA broadcasts will stream into.
          mirrorStreamRef.current[m.chatId] = uid();
          setMessages(prev => ({
            ...prev,
            [m.chatId]: [...(prev[m.chatId] || []), { id: uid(), role: 'user' as const, text: (m.prompt as string) || '' }],
          }));
          setGenerating(prev => ({ ...prev, [m.chatId]: true }));
        } else {
          const aId = mirrorStreamRef.current[m.chatId];
          if (aId) finalizeStreamingMessage(m.chatId, aId);
          delete mirrorStreamRef.current[m.chatId];
          setGenerating(prev => ({ ...prev, [m.chatId]: false }));
          loadChatHistory(m.chatId); // reconcile the mirrored answer with the saved one
        }
        return;
      }
      if (m.action === 'CHAT_DELTA') {
        if (streamingChatsRef.current.has(m.chatId)) return; // our own stream renders via the port
        // A delta can arrive before this panel processed CHAT_STATE:true (or it
        // mounted mid-stream) — open a mirror on the fly so nothing is dropped.
        let aId = mirrorStreamRef.current[m.chatId];
        if (!aId) { aId = uid(); mirrorStreamRef.current[m.chatId] = aId; setGenerating(prev => ({ ...prev, [m.chatId]: true })); }
        appendMirrorDelta(m.chatId, aId, (m.text as string) || '');
        return;
      }
      if (m.action === 'CHAT_RESET') {
        if (streamingChatsRef.current.has(m.chatId)) return;
        const aId = mirrorStreamRef.current[m.chatId];
        if (aId) resetStreamingMessage(m.chatId, aId);
        return;
      }
      if (m.action === 'DEEP_RESEARCH_DELTA') {
        // Report tokens are intentionally NOT rendered live. Re-parsing the
        // whole growing markdown report every flush saturated the main thread
        // (frozen caret / unresponsive panel, worst while a second session was
        // open). The field log shows synthesis progress; the fully-rendered
        // report lands via loadChatHistory on DONE. Deltas are dropped here.
        return;
      }
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
        // Clearing the flag is idempotent — always do it, even for a duplicate.
        setResearching(prev => ({ ...prev, [m.projectId]: false }));
        // But show the toast / log line only once per finish (Stop double-fires).
        const now = Date.now();
        if (now - (doneGuardRef.current[m.projectId] || 0) < 4000) return;
        doneGuardRef.current[m.projectId] = now;

        // On failure, flip the started plan card to a retryable 'failed' state
        // (the plan — topic + sub-questions — is preserved on the card, so Retry
        // just re-runs it). On success/cancel the report/history load handles it.
        if (m.error && !m.cancelled && m.chatId) {
          setMessages(prev => {
            const list = prev[m.chatId] || [];
            const idx = [...list].reverse().findIndex(x => x.plan && x.plan.status === 'started');
            if (idx === -1) return prev;
            const realIdx = list.length - 1 - idx;
            const copy = [...list];
            copy[realIdx] = { ...copy[realIdx], plan: { ...copy[realIdx].plan!, status: 'failed', error: String(m.error) } };
            return { ...prev, [m.chatId]: copy };
          });
        }

        // The persisted, fully-rendered report lands here (not streamed live).
        if (m.chatId) loadChatHistory(m.chatId);
        loadDocuments(m.projectId);
        const line = m.cancelled
          ? '[STOPPED] Research cancelled.'
          : m.error
            ? `[ERROR] Research failed: ${m.error}`
            : '[SUCCESS] Deep research complete — results added to chat.';
        setResearchLogs(prev => ({ ...prev, [m.projectId]: [...(prev[m.projectId] || []), line] }));
        if (m.cancelled) showToast('info', 'Research cancelled');
        else showToast(m.error ? 'error' : 'success', m.error ? `Research failed: ${m.error}` : 'Deep research complete!');

        // Run anything the user queued during the run, in order.
        drainQueueRef.current(m.projectId);
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

    // Lifecycle port: tells the worker this TAB's panel is open, so the
    // toolbar icon can toggle open/close reliably. The panel is tab-scoped,
    // and at mount its own tab is the active one — query it for the id.
    let lifecyclePort: chrome.runtime.Port | null = null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.connect && chrome.tabs?.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (typeof tabId !== 'number') return;
        try {
          lifecyclePort = chrome.runtime.connect({ name: 'sidepanel-lifecycle' });
          lifecyclePort.postMessage({ type: 'OPEN', tabId });
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

  // ──────── Export the active workspace to a folder (on demand) ────────
  // Documents already live in the browser (IndexedDB) — the source of truth.
  // This is the ONLY disk write, and only when the user clicks Export: a
  // one-shot File System Access grant used inside the click, so there is no
  // stored handle to expire and no download. Research-source scrapes are
  // excluded (the report + consolidated list are kept).
  const exportWorkspaceToFolder = async () => {
    // @ts-ignore — showDirectoryPicker isn't in older TS lib DOM defs
    if (typeof window.showDirectoryPicker !== 'function') {
      showToast('error', 'This browser can\'t open a folder picker — use a Chromium browser.');
      return;
    }
    const project = projects.find(p => p.id === activeProjectId);
    const files = documents
      .filter(doc => doc.content && !contentHasTag(doc.content, 'research-source'))
      .map(doc => ({ name: doc.title, content: doc.content }));
    if (files.length === 0) { showToast('error', 'Nothing to export in this workspace yet.'); return; }
    try {
      // requestPermission is implicit in showDirectoryPicker; keep it the FIRST
      // await so Chrome still sees the click's user activation.
      // @ts-ignore
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const wsName = sanitizeSegment(project?.title || 'workspace');
      const wsDir = await dir.getDirectoryHandle(wsName, { create: true });
      let written = 0;
      for (const f of files) {
        const fileName = `${sanitizeSegment(f.name) || 'untitled'}.md`;
        try {
          const fh = await wsDir.getFileHandle(fileName, { create: true });
          const w = await fh.createWritable();
          await w.write(f.content);
          await w.close();
          written++;
        } catch (e) {
          console.warn(`[export] failed ${fileName}:`, e);
        }
      }
      showToast('success', `Exported ${written} file(s) to ${dir.name}/${wsName}/`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[export] failed:', err);
        showToast('error', `Export failed — ${err?.message || 'check the folder permissions'}`);
      }
    }
  };

  // ──────── Async Import Progress (PDF + Images) ────────
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const importChannel = new BroadcastChannel('ai_research_assistant_import');
    importChannel.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'pdf-page') {
        // Live per-page progress for big PDFs — proves the parse is alive.
        showToast('info', `📄 Parsing page ${data.page}/${data.totalPages}…`);
      } else if (data.type === 'pdf-progress') {
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

  // Load chat history whenever the active chat changes, and publish the active
  // session pair so other windows follow. Writing here (not in the project
  // effect) means the chat id is always one that belongs to activeProjectId —
  // loadChats has already reconciled it — so the stored pair is never
  // inconsistent.
  // Append a mirrored token DIRECTLY to state (create the assistant message on
  // first token). Deliberately NOT via pushDelta: that batches through
  // requestAnimationFrame, which the browser pauses in a non-focused/hidden
  // panel — so the mirror would buffer but never paint until refocused. The
  // background already coalesces tokens, so per-message setState is fine.
  const appendMirrorDelta = useCallback((chatId: string, aId: string, text: string) => {
    if (!text) return;
    setMessages(prev => {
      const list = prev[chatId] || [];
      const idx = list.findIndex(x => x.id === aId);
      if (idx === -1) return { ...prev, [chatId]: [...list, { id: aId, role: 'assistant' as const, text, streaming: true }] };
      const copy = [...list];
      copy[idx] = { ...copy[idx], text: copy[idx].text + text, streaming: true };
      return { ...prev, [chatId]: copy };
    });
  }, []);

  // If another instance is mid-answer in this chat, seed a live mirror from the
  // in-flight text so a panel that just mounted / switched to this chat keeps
  // streaming instead of missing the answer. No-op if we're the initiator.
  const resumeMirror = useCallback((chatId: string) => {
    if (!chatId || streamingChatsRef.current.has(chatId) || mirrorStreamRef.current[chatId]) return;
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    msg('GET_CHAT_STREAM', { chatId }).then((r: any) => {
      if (!r?.generating || streamingChatsRef.current.has(chatId) || mirrorStreamRef.current[chatId]) return;
      const aId = uid();
      mirrorStreamRef.current[chatId] = aId;
      setGenerating(prev => ({ ...prev, [chatId]: true }));
      if (r.full) appendMirrorDelta(chatId, aId, r.full as string);
    }).catch(() => {});
  }, [appendMirrorDelta]);

  useEffect(() => {
    if (activeChatId) {
      if (typeof chrome !== 'undefined' && chrome.storage && activeProjectId) {
        const json = JSON.stringify({ projectId: activeProjectId, chatId: activeChatId });
        if (json !== lastSessionJsonRef.current) {
          lastSessionJsonRef.current = json;
          chrome.storage.local.set({ araActiveSession: { projectId: activeProjectId, chatId: activeChatId } });
        }
      }
      loadChatHistory(activeChatId).then(() => resumeMirror(activeChatId));
    }
  }, [activeChatId, activeProjectId]);

  // Self-healing "researching" flag: DEEP_RESEARCH_DONE broadcasts can be
  // missed (panel closed, other window asleep), which left the field-log
  // card up forever. While ANY project shows researching, poll the worker
  // every 5s and clear flags for projects with no live run. Startup grace:
  // the worker spends seconds on topic resolution BEFORE the run is
  // registered — clearing during that window flickers the field-log card
  // (mount/unmount loop) and eats the logs, so young flags are left alone.
  const researchStartedAtRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const anyResearching = Object.values(researching).some(Boolean);
    if (!anyResearching) return;
    const GRACE_MS = 90_000;
    const check = () => {
      msg('GET_RESEARCH_STATUS').then((res: any) => {
        if (!res?.success) return;
        const liveProject = res.running ? res.job?.projectId : null;
        let died = false;
        setResearching(prev => {
          let changed = false;
          const next = { ...prev };
          for (const pid of Object.keys(next)) {
            if (!next[pid] || pid === liveProject) continue;
            const startedAt = researchStartedAtRef.current[pid] ?? 0;
            if (Date.now() - startedAt < GRACE_MS) continue; // still starting up
            next[pid] = false;
            changed = true;
            died = true;
          }
          return changed ? next : prev;
        });
        // A run that vanished without a DEEP_RESEARCH_DONE (the worker/offscreen
        // crashed, or the panel outlived the run) leaves its plan card stuck on
        // "Running". Flip it to a retryable 'failed' state so it doesn't hang and
        // the user can re-run. Only one research runs at a time, so this targets
        // the single started card.
        if (died) {
          setMessages(prev => {
            let changed = false;
            const next = { ...prev };
            for (const cid of Object.keys(next)) {
              const idx = next[cid].findIndex(x => x.plan && x.plan.status === 'started');
              if (idx === -1) continue;
              const copy = [...next[cid]];
              copy[idx] = { ...copy[idx], plan: { ...copy[idx].plan!, status: 'failed', error: 'Research was interrupted — the worker crashed or the run was lost.' } };
              next[cid] = copy;
              changed = true;
            }
            return changed ? next : prev;
          });
        }
      }).catch(() => {});
    };
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

  // Open a document (optionally at a chunk anchor). The GLOBAL doc list ships
  // WITHOUT its markdown body (that unbounded payload was OOMing the panel), so
  // hydrate the full doc via GET_DOCUMENT unless the bounded project list already
  // carries it. Upsert the hydrated copy into globalDocuments so DocumentView —
  // which reads from that state — shows the full body.
  const openDocById = async (docId: string, anchorId?: string | null, returnView?: 'lore' | 'chat') => {
    const inProject = documents.find(d => d.id === docId);
    if (!inProject?.content) {
      const res = await msg('GET_DOCUMENT', { docId });
      if (res.success && res.document) {
        const full = res.document as LocalDocument;
        setGlobalDocuments(prev => [...prev.filter(d => d.id !== docId), full]);
      }
    }
    if (returnView) docReturnViewRef.current = returnView;
    setActiveDocumentId(docId);
    setHighlightAnchorId(anchorId || null);
    setView('document');
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
          m => m.plan && (m.plan.status === 'draft' || m.plan.status === 'refining' || m.plan.status === 'loading' || m.plan.status === 'failed')
        );
        // Empty history → keep the array empty and let ChatView show its
        // onboarding card. (A synthetic "welcome" system message used to live
        // here, but it lingered above real messages after the first send —
        // optimistic sends append onto whatever's already in the array.)
        const hist = (res.messages as any[]).length > 0
          ? (res.messages as ChatMessage[])
          : [];
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
  const showToast = (type: 'success' | 'error' | 'info', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4000);
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


  /** Import local PDFs — parsed by code first, vision model only for scanned pages. */
  const importPdfFiles = async () => {
    try {
      // @ts-ignore — File System Access API
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]
      });
      if (!activeProjectId) { showToast('error', 'No active session'); return; }

      // STREAM each PDF into OPFS instead of reading it to base64. Reading a
      // 10 MB file to base64 held several 14 MB string copies in the small
      // panel renderer and OOM-crashed it the moment a big PDF was selected.
      // OPFS write() streams the bytes to disk (no full in-memory copy) and the
      // offscreen doc reads them back directly — nothing large crosses a
      // message. Works for large books.
      const root = await navigator.storage.getDirectory();
      const files: Array<{ name: string; opfsName: string; size: number }> = [];
      for (const h of handles) {
        const file: File = await h.getFile();
        const opfsName = `import-${crypto.randomUUID?.() ?? Date.now()}.pdf`;
        const fh = await root.getFileHandle(opfsName, { create: true });
        const w = await fh.createWritable();
        await w.write(file);        // streamed, not buffered as base64
        await w.close();
        files.push({ name: file.name, opfsName, size: file.size });
      }
      if (files.length === 0) return;

      showToast('success', `📄 Sending ${files.length} PDF(s) for background parsing...`);

      // Send only the OPFS names — the bytes never cross this message.
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

  const downloadDoc = async (doc: LocalDocument) => {
    // The global doc list ships frontmatter-only (heap), so never trust the list
    // copy's body — always pull the full markdown from the store for download.
    let content = doc.content || '';
    const res = await msg('GET_DOCUMENT', { docId: doc.id });
    const fullContent = res.success ? (res.document as LocalDocument | undefined)?.content : undefined;
    if (fullContent) content = fullContent;
    if (!content) {
      showToast('error', 'Content not available for download.');
      return;
    }
    const blob = new Blob([content], { type: 'text/markdown' });
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
      // "Login and it just works": pull the user's Drive folder in, then push
      // anything local that isn't there yet — no separate Sync click needed.
      importFromDrive().then(() => syncToDrive()).catch(() => {});
    } else {
      const err = String(res.error || '');
      // A missing/placeholder oauth2.client_id surfaces as "bad client id" /
      // "OAuth2 not granted". Point the publisher at the one-time setup.
      const needsSetup = /client id|oauth2|not granted|invalid|configured/i.test(err);
      showToast('error', needsSetup
        ? 'Google sign-in isn’t configured yet — see docs/DRIVE-SETUP.md (one-time).'
        : `Sign-in failed — ${err || 'try again'}`);
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
    const commandMsg: ChatMessage = { id: uid(), role: 'user', text: `[${label}] ${userQuery}` };
    setMessages(prev => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []), commandMsg]
    }));
    setGenerating(prev => ({ ...prev, [currentChatId]: true }));

    const port = chrome.runtime.connect({ name: 'chat-stream' });
    chatPortRef.current = port;
    let finished = false;
    const assistantId = uid();

    const finish = () => {
      if (finished) return;
      finished = true;
      // ALWAYS clear the streaming flag here — a port that disconnects without
      // a DONE (MV3 worker evicted mid-answer, network drop) would otherwise
      // leave the message frozen with its blinking cursor forever. Idempotent:
      // DONE/ERROR already finalized, this is a no-op then.
      finalizeStreamingMessage(currentChatId, assistantId);
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      setThinkingStatus(prev => ({ ...prev, [currentChatId]: '' }));
      if (chatPortRef.current === port) chatPortRef.current = null;
    };

    port.onMessage.addListener((m: any) => {
      if (m.type === 'STATUS') {
        setThinkingStatus(prev => ({ ...prev, [currentChatId]: m.text || '' }));
      } else if (m.type === 'DELTA') {
        setThinkingStatus(prev => prev[currentChatId] ? { ...prev, [currentChatId]: '' } : prev);
        pushDelta(currentChatId, assistantId, m.text);
      } else if (m.type === 'DONE' || m.type === 'ERROR') {
        finalizeStreamingMessage(currentChatId, assistantId);
        if (m.type === 'ERROR') {
          setMessages(prev => ({
            ...prev,
            [currentChatId]: [...(prev[currentChatId] || []), {
              id: uid(),
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
        [activeChatId]: [...(prev[activeChatId] || []), { id: uid(), role: 'system' as const, text: body }]
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
        [currentChatId]: [...(prev[currentChatId] || []), { id: uid(), role: 'user', text }]
      }));
      setGenerating(prev => ({ ...prev, [currentChatId]: true }));
      const res = await msg('CREATE_SKILL', { projectId: activeProjectId, chatId: currentChatId, instruction });
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      const body = res.success !== false && res.cmd
        ? `**Skill created: \`${res.cmd}\`**\n\n${res.desc}\n\nUse it right away — type \`${res.cmd} <your question>\` in any chat. It's saved under Config → Custom Commands (edit or delete there), and a copy lives in Lore as **Skill: ${res.cmd}**.\n\n<details><summary>What the skill knows</summary>\n\n${res.systemPrompt}\n\n</details>`
        : `Skill creation failed: ${res.error || 'unknown error'}`;
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), { id: uid(), role: 'system', text: body }]
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
          id: uid(),
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
    setInput('');

    // Real queue: while research runs on this project, a chat question waits
    // behind it instead of racing it. Show the message now with a "Queued"
    // badge; drainQueue runs it (and any others, in order) once research ends.
    if (researching[currentProjectId]) {
      const queuedId = uid();
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), {
          id: queuedId, role: 'user' as const,
          text: forcePageContext ? `[📄 Current Page] ${messageText}` : messageText,
          queued: true
        }]
      }));
      (queuedRef.current[currentChatId] ||= []).push({ id: queuedId, text: messageText, forcePageContext, projectId: currentProjectId });
      return;
    }

    maybeAutoNameProject(messageText).catch(() => {});
    await runChatStream(currentChatId, currentProjectId, messageText, forcePageContext);
  };

  /**
   * Stream one chat turn over a long-lived port. Resolves when the stream
   * finishes (DONE/ERROR/disconnect). `existingUserMsgId` is set when the user
   * bubble already exists (a queued message being drained) — we just clear its
   * "queued" badge instead of adding a new bubble.
   */
  const runChatStream = (
    currentChatId: string, currentProjectId: string, messageText: string,
    forcePageContext: boolean, existingUserMsgId?: string
  ): Promise<void> => new Promise<void>((resolve) => {
    const assistantId = uid();

    if (existingUserMsgId) {
      setMessages(prev => {
        const list = prev[currentChatId] || [];
        const idx = list.findIndex(x => x.id === existingUserMsgId);
        if (idx === -1) return prev;
        const copy = [...list];
        copy[idx] = { ...copy[idx], queued: false };
        return { ...prev, [currentChatId]: copy };
      });
    } else {
      setMessages(prev => ({
        ...prev,
        [currentChatId]: [...(prev[currentChatId] || []), {
          id: uid(), role: 'user' as const,
          text: forcePageContext ? `[📄 Current Page] ${messageText}` : messageText
        }]
      }));
    }
    setGenerating(prev => ({ ...prev, [currentChatId]: true }));
    streamingChatsRef.current.add(currentChatId);

    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      streamingChatsRef.current.delete(currentChatId);
      resolve();
      return;
    }

    const port = chrome.runtime.connect({ name: 'chat-stream' });
    chatPortRef.current = port;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      streamingChatsRef.current.delete(currentChatId);
      // A disconnect without DONE must still clear the streaming flag or the
      // blinking cursor sticks forever.
      finalizeStreamingMessage(currentChatId, assistantId);
      setGenerating(prev => ({ ...prev, [currentChatId]: false }));
      setThinkingStatus(prev => ({ ...prev, [currentChatId]: '' }));
      if (chatPortRef.current === port) chatPortRef.current = null;
      resolve();
    };

    port.onMessage.addListener((m: any) => {
      if (m?.type === 'STATUS') {
        setThinkingStatus(prev => ({ ...prev, [currentChatId]: m.text || '' }));
      } else if (m?.type === 'RESET') {
        // Worker is replacing the answer (refusal → web-sourced answer).
        resetStreamingMessage(currentChatId, assistantId);
      } else if (m?.type === 'DELTA') {
        setThinkingStatus(prev => prev[currentChatId] ? { ...prev, [currentChatId]: '' } : prev);
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
            id: uid(), role: 'system' as const,
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
  });

  /** Run every message queued behind a finished research run, in order. */
  const drainQueue = async (projectId: string) => {
    for (const chatId of Object.keys(queuedRef.current)) {
      const items = queuedRef.current[chatId] || [];
      const mine = items.filter(it => it.projectId === projectId);
      if (mine.length === 0) continue;
      queuedRef.current[chatId] = items.filter(it => it.projectId !== projectId);
      for (const it of mine) {
        // Sequential — each waits for the prior stream to finish (and the
        // offscreen mutex keeps embeds from colliding regardless).
        await runChatStream(chatId, projectId, it.text, it.forcePageContext, it.id).catch(() => {});
      }
    }
  };
  // Latest drainQueue for the once-registered DONE listener to call.
  drainQueueRef.current = drainQueue;

  const clearChat = async () => {
    if (!activeChatId) return;
    await msg('CLEAR_CHAT_HISTORY', { chatId: activeChatId });
    // Empty the array so ChatView shows its onboarding card; a persistent
    // "chat cleared" system message would linger above the next reply.
    setMessages(prev => ({ ...prev, [activeChatId]: [] }));
    showToast('success', 'Chat cleared');
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
        { id: uid(), role: 'user', text: `${mode === 'deep' ? '/deepresearch' : '/research'} ${topic}` },
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
          stages: (preview.stages as number) || undefined,
          estMinutes: (preview.estMinutes as number) || undefined,
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
      [currentChatId]: [...(prev[currentChatId] || []), { id: uid(), role: 'user', text: feedback }]
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
          id: uid(), role: 'system',
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
    researchStartedAtRef.current[activeProjectId] = Date.now();
    setResearching(prev => ({ ...prev, [activeProjectId]: true }));
    setResearchLogs(prev => ({ ...prev, [activeProjectId]: [] }));
    maybeAutoNameProject(plan.effectiveTopic).catch(() => {});

    // Fire-and-forget: Chrome drops sendResponse after ~5 min, which
    // would make msg() resolve with "No response" and show a false
    // "Research failed" error. Instead, we don't await the result at all.
    // Completion/failure is handled by the DEEP_RESEARCH_DONE broadcast.
    msg('START_DEEP_RESEARCH', {
      projectId: activeProjectId,
      chatId: activeChatId,
      topic: plan.effectiveTopic,
      mode: plan.mode
    }).catch(() => {});
    // All state updates happen in the DEEP_RESEARCH_DONE and DEEP_RESEARCH_LOG handlers
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
        <header className="card-rule flex items-center px-3.5 py-2.5 bg-card gap-2 shrink-0">
          {editingProjectId ? (
            <input
              autoFocus
              type="text"
              className="flex h-8 w-full rounded-lg border border-primary/50 bg-background px-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
              defaultValue={projects.find(p => p.id === activeProjectId)?.title || ''}
              onBlur={(e) => handleProjectRenameSubmit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleProjectRenameSubmit(e.currentTarget.value);
                if (e.key === 'Escape') setEditingProjectId('');
              }}
            />
          ) : (
            <div className="flex items-center flex-1 min-w-0 gap-0.5 rounded-lg hover:bg-accent/70 transition-colors">
              <Select
                value={activeProjectId || ''}
                onValueChange={(val) => {
                  if (!val) return;
                  if (val === 'new') createNewProject();
                  else setActiveProjectId(val as string);
                }}
              >
                <SelectTrigger className="h-8 border-none shadow-none bg-transparent hover:bg-transparent focus:ring-0 p-0 px-2 truncate w-full text-sm font-semibold">
                  <SelectValue placeholder="Select a workspace…">
                    {projects.find(p => p.id === activeProjectId)?.title || 'Select a workspace…'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="border border-border rounded-lg shadow-card">
                  {projects.map(p => (
                    <SelectItem key={p.id} value={p.id} className="rounded-md text-sm">{p.title}</SelectItem>
                  ))}
                  <SelectSeparator className="bg-border" />
                  <SelectItem value="new" className="text-primary font-medium rounded-md text-sm">+ New workspace</SelectItem>
                </SelectContent>
              </Select>
              {activeProjectId && (
                <button className="text-muted-foreground hover:text-primary shrink-0 p-2" onClick={() => setEditingProjectId(activeProjectId)} title="Rename Workspace">
                  <Edit2 size={14} />
                </button>
              )}
              {activeProjectId && projects.length > 1 && (
                <button
                  className={`shrink-0 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                    confirmDeleteProjectId === activeProjectId
                      ? 'text-destructive bg-destructive/10 hover:bg-destructive hover:text-destructive-foreground'
                      : 'text-muted-foreground hover:text-destructive'
                  }`}
                  onClick={deleteProject}
                  title={confirmDeleteProjectId === activeProjectId ? 'Click again to confirm delete' : 'Delete workspace'}
                  aria-label={confirmDeleteProjectId === activeProjectId ? 'Confirm workspace deletion' : 'Delete workspace'}
                >
                  {confirmDeleteProjectId === activeProjectId ? 'Delete?' : <Trash2 size={14} />}
                </button>
              )}
            </div>
          )}
        </header>
      )}

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col overflow-hidden relative bg-background border-b border-border">
        {toast && (
          <div className={`absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-xs font-medium rounded-lg animate-in slide-in-from-top-2 shadow-card ${
            toast.type === 'error' ? 'bg-destructive text-destructive-foreground'
              : toast.type === 'info' ? 'ink-panel'
              : 'bg-primary text-primary-foreground'
          }`}>
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
            <div className="text-sm truncate font-medium flex-1 text-foreground">{tabInfo.title}</div>
            <Button size="sm" onClick={capture} disabled={capturing} variant="default" className="shrink-0 h-8 text-xs rounded-lg font-semibold">
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
              onDocumentClick={(id, anchorId) => openDocById(id, anchorId, 'lore')}
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
              resolveCitations={resolveCitations}
              onOpenDocument={(docId, anchorId) => openDocById(docId, anchorId)}
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
              thinkingStatus={thinkingStatus}
              researching={researching}
              isActive={view === 'chat'}
              llmEndpointLocal={/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(customUrl.trim())}
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

              onOpenDocument={(docId, anchorId) => openDocById(docId, anchorId, 'chat')}
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
              exportWorkspace={exportWorkspaceToFolder}
              autoLinkCaptures={autoLinkCaptures}
              setAutoLinkCaptures={(v) => {
                setAutoLinkCaptures(v);
                if (typeof chrome !== 'undefined' && chrome.storage) {
                  chrome.storage.local.set({ autoLinkCaptures: v });
                }
              }}
              saveSettings={saveSettings}
              workspaceName={projects.find(p => p.id === activeProjectId)?.title || 'this workspace'}
              workspaceRules={projects.find(p => p.id === activeProjectId)?.rules || ''}
              saveWorkspaceRules={async (rules: string) => {
                if (!activeProjectId) return;
                await msg('UPDATE_PROJECT', { id: activeProjectId, rules });
                loadProjects();
                showToast('success', 'Workspace instructions saved');
              }}
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
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors rounded-lg relative ${
                view === key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              onClick={onClick}
              aria-current={view === key ? 'page' : undefined}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
              {key === 'chat' && researching[activeProjectId] && (
                <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" title="Research running" aria-label="Research running" />
              )}
            </button>
          </Fragment>
        ))}
      </nav>
    </div>
  );
}
