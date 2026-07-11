// ─────────────────────────────────────────────
// Background Service Worker — AI Research Assistant v2
// ─────────────────────────────────────────────
// Local-first storage (IndexedDB), multi-provider AI,
// source-grounded citation prompts, optional Drive sync.

import {
  saveDocument, listDocuments, updateDocumentSync,
  getUnsyncedDocuments, getChatHistory, clearChatHistory, saveChatMessage,
  createProject, listProjects, getProject, updateProjectTitle, deleteProject,
  createChat, listChats, updateChatTitle, deleteChat,
  linkDocumentToProject, updateDocumentContent,
  getChunkByAnchor
} from '../lib/db';
import { chunkDocument, makeDocShortId } from '../lib/chunker';
import { buildCitationContext, CITATION_SYSTEM_PROMPT, parseResponseCitations } from '../lib/citations';
import { buildFrontmatter, hasFrontmatter } from '../lib/frontmatter';
import { get as idbGet } from 'idb-keyval';
import { runDeepResearch } from './deep-researcher';
import { addChunksToVectorStore, searchSessionChunks, resetSessionIndex, resetAllSessionIndexes } from '../lib/vector-store';
import { replaceChunksForDoc } from '../lib/db';
import { pdfBase64ToBody, pdfUrlToBody, ensureOffscreen as ensureOffscreenDoc } from '../lib/pdf-parser';
import { getProviderSettings, chatWithCustom, chatWithCustomStream, handleFetchCustomModels } from './llm-client';
import { handleSearchLibrary, handleRecallDocs } from './library-handlers';
import { handleLinkDocument, handleUnlinkDocument, handleListDocuments, handleGetDocument, handleDeleteDocument, handleGetDocumentCount, handleUpdateDocumentSelection } from './document-handlers';
import {
  startJob as startResearchJob, getJob as getResearchJob,
  clearJob as clearResearchJob, appendJobLog, incrementResumeAttempts,
  markJobActive, markJobFinished, updateHeartbeat, JOB_MAX_AGE_MS, HEARTBEAT_STALE_MS
} from '../lib/research-store';

// ─────────────────────────────────────────────
// Defaults and State
// ─────────────────────────────────────────────
const abortControllers = new Map<string, AbortController>();

// ─────────────────────────────────────────────
// Side Panel — toggle on icon click
// ─────────────────────────────────────────────
// State is driven by a lifecycle port the sidepanel opens on mount (see
// App.tsx), so the map stays accurate even when the user closes the panel
// with its own X button.
const sidePanelOpen = new Map<number, boolean>();

chrome.action.onClicked.addListener((tab) => {
  // NOTE: sidePanel.open() must be called synchronously inside this handler.
  // Any `await` before it drops the user-gesture context and Chrome rejects
  // the call ("may only be called in response to a user gesture").
  if (!chrome.sidePanel || !tab.windowId) return;
  const windowId = tab.windowId;
  const isOpen = sidePanelOpen.get(windowId) ?? false;

  if (isOpen) {
    // Close by disabling the side panel, then re-arm for the next open.
    // No gesture needed here, so promises are fine.
    sidePanelOpen.set(windowId, false);
    chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false })
      .then(() => chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true }))
      .catch(() => {});
  } else {
    // Fire setOptions without awaiting, then open() while the gesture is live
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
    chrome.sidePanel.open({ windowId }).catch((e) => console.warn('sidePanel.open failed:', e));
    sidePanelOpen.set(windowId, true);
  }
});

// Sidepanel lifecycle port — marks its window open while connected
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel-lifecycle') return;
  let trackedWindowId: number | null = null;
  port.onMessage.addListener((m) => {
    if (m?.type === 'OPEN' && typeof m.windowId === 'number') {
      trackedWindowId = m.windowId;
      sidePanelOpen.set(m.windowId, true);
    }
  });
  port.onDisconnect.addListener(() => {
    if (trackedWindowId !== null) sidePanelOpen.set(trackedWindowId, false);
  });
});

// ─────────────────────────────────────────────
// Declarative Net Request — Strip Origin for Ollama
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.declarativeNetRequest) {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Origin', operation: 'remove' }]
        },
        condition: {
          urlFilter: '|http://localhost:11434/*',
          resourceTypes: ['xmlhttprequest']
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Origin', operation: 'remove' }]
        },
        condition: {
          urlFilter: '|http://127.0.0.1:11434/*',
          resourceTypes: ['xmlhttprequest']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2],
      addRules: rules as any
    });
  }

  // Create context menu for capturing selected text
  chrome.contextMenus.create({
    id: 'capture-selection',
    title: 'Capture selection to Workspace',
    contexts: ['selection']
  });

  // Full-page capture from the right-click menu
  chrome.contextMenus.create({
    id: 'capture-page',
    title: 'Capture page to Library',
    contexts: ['page']
  });

  // Create workspace two-way sync alarm (every 5 minutes)
  chrome.alarms.create('sync-workspace', { periodInMinutes: 5 });
});

// Setup alarm checks on startup to be safe
chrome.alarms.get('sync-workspace', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('sync-workspace', { periodInMinutes: 5 });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync-workspace') {
    await performTwoWaySync();
  }
});

async function performTwoWaySync() {
  try {
    // NOTE: dynamic import() is banned in MV3 service workers — use the
    // static idb-keyval import from the top of this file.
    const handle: any = await idbGet('ara-local-directory-handle');
    if (!handle) return;

    // Check permission status
    // @ts-ignore
    const hasPermission = await handle.queryPermission({ mode: 'readwrite' });
    if (hasPermission !== 'granted') return;

    const activeProjectId = await idbGet('ara-active-project-id');
    if (!activeProjectId) return;

    const docs = await listDocuments(activeProjectId);
    const dbDocsMap = new Map(docs.map(d => [d.title, d]));

    const localFiles = new Map<string, { handle: any; file: File }>();

    // @ts-ignore
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.md')) {
        const file = await entry.getFile();
        const title = entry.name.slice(0, -3);
        localFiles.set(title, { handle: entry, file });
      }
    }

    // 1. Local Folder -> IndexedDB
    for (const [title, local] of localFiles.entries()) {
      const dbDoc = dbDocsMap.get(title);
      const localLastModified = local.file.lastModified;
      const localTimeIso = new Date(localLastModified).toISOString();

      if (!dbDoc) {
        const text = await local.file.text();
        const docShortId = makeDocShortId(crypto.randomUUID?.() ?? `${Date.now()}`);
        const chunks = chunkDocument({ docShortId, content: text });

        const { id: docId, chunks: savedChunks } = await saveDocument({
          title,
          url: '',
          content: text,
          capturedAt: localTimeIso,
          favicon: '',
          syncedToDrive: false,
          enabled: true,
          wordCount: text.split(/\s+/).filter(Boolean).length
        }, chunks);

        await linkDocumentToProject(activeProjectId, docId);
        await addChunksToVectorStore(activeProjectId, savedChunks);

        notifySidepanelSync();
      } else {
        const dbTime = new Date(dbDoc.capturedAt).getTime();
        if (localLastModified > dbTime + 2000) {
          const text = await local.file.text();
          if (text !== dbDoc.content) {
            const docShortId = makeDocShortId(dbDoc.id);
            const chunks = chunkDocument({ docShortId, content: text });

            const savedChunks = await updateDocumentContent(dbDoc.id, text, chunks, localTimeIso);
            await addChunksToVectorStore(activeProjectId, savedChunks);

            notifySidepanelSync();
          }
        }
      }
    }

    // 2. IndexedDB -> Local Folder
    for (const dbDoc of docs) {
      const local = localFiles.get(dbDoc.title);
      const dbTime = new Date(dbDoc.capturedAt).getTime();

      const cleanTitle = dbDoc.title.trim()
        .normalize('NFC')
        .replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, '')
        .replace(/[^\w\s\-().,'!&+#@\[\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')
        .replace(/\.+$/, '')
        .trim();
      const fileName = `${cleanTitle.slice(0, 100) || 'untitled'}.md`;

      if (!local) {
        // @ts-ignore
        const fileHandle = await handle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(dbDoc.content);
        await writable.close();
      } else if (dbTime > local.file.lastModified + 2000) {
        const writable = await local.handle.createWritable();
        await writable.write(dbDoc.content);
        await writable.close();
      }
    }
  } catch (e) {
    console.error('Two-way sync failed', e);
  }
}

function notifySidepanelSync() {
  const channel = new BroadcastChannel('ai_research_assistant_sync');
  channel.postMessage('SYNC_STATE');
  channel.close();
}

/** Flash a short-lived badge on the extension icon (capture feedback). */
function flashBadge(text: string, ok: boolean) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
  } catch { /* badge is cosmetic */ }
}

/**
 * Where should a fresh capture be linked?
 * - explicit projectId wins;
 * - otherwise the "auto-add to active workspace" setting (default ON) links
 *   to the active project;
 * - otherwise the doc stays global-library-only.
 */
async function resolveLinkTarget(explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const s = await chrome.storage.local.get(['autoLinkCaptures']);
  if (s.autoLinkCaptures === false) return null;
  return ((await idbGet('ara-active-project-id')) as string | undefined) || null;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'capture-selection' && info.selectionText) {
    const pageTitle = tab?.title || 'Unknown Page';
    const title = `Selection from ${pageTitle}`;
    const url = tab?.url || 'unknown';
    const capturedAt = new Date().toISOString();
    const wordCount = info.selectionText.split(/\s+/).filter(Boolean).length;
    const content =
      buildFrontmatter({ title, type: 'selection', source: url, captured: capturedAt, wordCount }) +
      `# ${title}\n\n> ${info.selectionText.replace(/\n/g, '\n> ')}\n\n---\n*Captured from: [${url}](${url})*`;

    try {
      const docShortId = makeDocShortId(crypto.randomUUID?.() ?? `${Date.now()}`);
      const chunks = chunkDocument({ docShortId, content });
      const { id: docId, chunks: savedChunks } = await saveDocument({
        title,
        url,
        favicon: tab?.favIconUrl,
        content,
        wordCount,
        syncedToDrive: false,
        capturedAt
      }, chunks);

      const linkTarget = await resolveLinkTarget();
      if (linkTarget) {
        await linkDocumentToProject(linkTarget, docId);
        await addChunksToVectorStore(linkTarget, savedChunks);
      }

      flashBadge('✓', true);
      notifySidepanelSync();
    } catch (e) {
      console.error('Failed to save selection', e);
      flashBadge('!', false);
    }
  }

  if (info.menuItemId === 'capture-page' && tab?.id) {
    try {
      await captureTab(tab, null);
      flashBadge('✓', true);
      notifySidepanelSync();
    } catch (e) {
      console.error('Failed to capture page from context menu', e);
      flashBadge('!', false);
    }
  }
});

// ─────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = messageHandlers[request.action];
  if (handler) {
    handler(request, sender)
      .then((result: unknown) => sendResponse({ success: true, ...(result as object) }))
      .catch((err: unknown) => sendResponse({
        success: false,
        error: String(err instanceof Error ? err.message : err)
      }));
    return true; // async response
  }
  return false;
});

type MessageHandler = (request: Record<string, unknown>, sender: chrome.runtime.MessageSender) => Promise<Record<string, unknown>>;

const messageHandlers: Record<string, MessageHandler> = {
  ENSURE_OFFSCREEN: async () => {
    await ensureOffscreen();
    return {};
  },
  // ── Projects ──
  CREATE_PROJECT: handleCreateProject,
  LIST_PROJECTS: handleListProjects,
  GET_PROJECT: handleGetProject,
  UPDATE_PROJECT: handleUpdateProject,
  DELETE_PROJECT: handleDeleteProject,

  // ── Chats ──
  CREATE_CHAT: handleCreateChat,
  LIST_CHATS: handleListChats,
  UPDATE_CHAT: handleUpdateChat,
  DELETE_CHAT: handleDeleteChat,

  // ── Document operations ──
  CAPTURE_PAGE: handleCapture,
  LIST_DOCUMENTS: handleListDocuments,
  GET_DOCUMENT: handleGetDocument,
  DELETE_DOCUMENT: handleDeleteDocument,
  GET_DOCUMENT_COUNT: handleGetDocumentCount,
  UPDATE_DOCUMENT_SELECTION: handleUpdateDocumentSelection,
  LINK_DOCUMENT: handleLinkDocument,
  UNLINK_DOCUMENT: handleUnlinkDocument,
  SEARCH_LIBRARY: handleSearchLibrary,
  REINDEX_LIBRARY: handleReindexLibrary,
  RECALL_DOCS: handleRecallDocs,

  // ── Chat ──
  CHAT_WITH_KNOWLEDGE: handleChat,
  GET_CHAT_HISTORY: handleGetChatHistory,
  CLEAR_CHAT_HISTORY: handleClearChatHistory,
  CANCEL_TASK: handleCancelTask,

  // ── Deep Research ──
  START_DEEP_RESEARCH: handleDeepResearch,
  GET_RESEARCH_STATUS: async () => {
    const job = await getResearchJob().catch(() => null);
    const running = job ? abortControllers.has(job.projectId) : false;
    return { job, running };
  },

  // ── Local Markdown import ──
  IMPORT_LOCAL_MD: handleImportLocalMd,
  IMPORT_LOCAL_PDF: handleImportLocalPdf,
  IMPORT_LOCAL_IMAGES: handleImportLocalImages,

  // ── Citations ──
  RESOLVE_CITATIONS: async (request) => {
    const parsed = await parseResponseCitations(request.text as string);
    return { citations: parsed.citations };
  },

  // ── Chunk lookup for highlight ──
  GET_CHUNK_BY_ANCHOR: async (request) => {
    const chunk = await getChunkByAnchor(request.anchorId as string);
    if (chunk) {
      return { success: true, chunk: { charStart: chunk.charStart, charEnd: chunk.charEnd, text: chunk.text, heading: chunk.heading, sectionPath: chunk.sectionPath } };
    }
    return { success: false };
  },

  // ── Models ──
  FETCH_CUSTOM_MODELS: handleFetchCustomModels,

  // ── Drive sync (optional) ──
  GET_OAUTH_TOKEN_INTERACTIVE: (_r) => getToken(true).then(token => ({ token })),
  GET_OAUTH_TOKEN_SILENT: (_r) => getToken(false).then(token => ({ token })),
  CLEAR_OAUTH_TOKEN: () => clearToken().then(() => ({})),
  SYNC_TO_DRIVE: handleSyncToDrive,
  IMPORT_FROM_DRIVE: handleImportFromDrive,
  LIST_DRIVE_FILES: handleListDriveFiles,

  // ── Utils ──
  GET_MAIN_WORLD_YT_RESPONSE: async (_r, sender) => {
    if (!sender.tab?.id) return { data: null };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: 'MAIN',
        files: ['inject.js']
      });
      return { data: results[0]?.result };
    } catch (e) {
      console.error('Failed to execute script in main world:', e);
      return { data: null };
    }
  }
};

// ─────────────────────────────────────────────
// Project and Chat Handlers
// ─────────────────────────────────────────────
async function handleCreateProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const title = (request.title as string) || 'New Project';
  const id = await createProject(title);
  return { id };
}

async function handleListProjects(): Promise<Record<string, unknown>> {
  const projects = await listProjects();
  return { projects };
}

async function handleGetProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const project = await getProject(request.id as string);
  return { project: project || null };
}

async function handleUpdateProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await updateProjectTitle(request.id as string, request.title as string);
  return {};
}

async function handleDeleteProject(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await deleteProject(request.id as string);
  return {};
}

async function handleCreateChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  const title = (request.title as string) || 'New Chat';
  if (!projectId) throw new Error('projectId is required to create a chat');
  const id = await createChat(projectId, title);
  return { id };
}

async function handleListChats(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  if (!projectId) throw new Error('projectId is required to list chats');
  const chats = await listChats(projectId);
  return { chats };
}

async function handleDeleteChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await deleteChat(request.id as string);
  return {};
}

async function handleUpdateChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { id, title } = request;
  if (!id || !title) throw new Error('id and title are required to update chat');
  await updateChatTitle(id as string, title as string);
  return {};
}

// ─────────────────────────────────────────────
// Document Handlers — Local-First
// ─────────────────────────────────────────────
async function handleCapture(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  // projectId is optional: captures always land in the global library and are
  // additionally linked per resolveLinkTarget (explicit id / auto-link setting).
  const explicitProjectId = (request.projectId as string) || null;

  // Get the active tab
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    throw new Error('No active tab found.');
  }

  return captureTab(tab, explicitProjectId);
}

/** Shared full-page capture used by the sidepanel button and the context menu. */
interface ScrapedPage {
  title: string;
  url: string;
  favicon: string;
  markdown: string;
  wordCount: number;
  kind?: string;
  author?: string;
}

/** Scrape a tab via the content script (injecting it if missing). For
 *  YouTube watch pages this returns the transcript, not the page DOM. */
async function scrapeTabViaContentScript(tab: chrome.tabs.Tab): Promise<ScrapedPage | null> {
  const send = () => new Promise<ScrapedPage>((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id!, { action: 'SCRAPE_PAGE' }, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });

  try {
    return await send();
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
      return await send();
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────
// Ephemeral Page Context — chat about the current tab WITHOUT capturing
// ─────────────────────────────────────────────
// Nothing here touches IndexedDB or the vector store: the page text only
// exists inside the single chat request. Cached briefly so multi-turn chat
// about one page (especially a PDF) doesn't re-scrape per message.

interface PageContext { title: string; url: string; markdown: string; }

interface PageChunkEmb { text: string; position: number; embedding: number[] | null }
const pageContextCache = new Map<string, { ctx: PageContext; ts: number; chunks?: PageChunkEmb[] }>();
const PAGE_CONTEXT_TTL_MS = 5 * 60 * 1000;

const MAX_PAGE_CHARS = 16000;
const PAGE_RETRIEVAL_BUDGET = 12000;

/**
 * Build the page markdown to inline into the chat request. Short pages go in
 * whole. Long pages (2-hour transcripts, full PDFs) switch to retrieval:
 * chunk once, embed once (cached alongside the page for the TTL), then per
 * question cosine-rank and inline only the most relevant sections — the old
 * head+tail truncation silently dropped the middle of long videos.
 * Everything stays in memory; nothing touches IndexedDB or the search index.
 */
async function selectPageMarkdown(ctx: PageContext, question: string): Promise<string> {
  const md = ctx.markdown;
  if (md.length <= MAX_PAGE_CHARS) return md;

  try {
    const entry = pageContextCache.get(ctx.url);
    let chunks = entry?.chunks;
    if (!chunks) {
      const raw = chunkDocument({ docShortId: 'dpage00', content: md });
      const texts = raw.map(c => c.text);
      const res: any = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts });
      const embeddings: (number[] | null)[] = res?.ok && Array.isArray(res.embeddings) ? res.embeddings : [];
      chunks = raw.map((c, i) => ({ text: c.text, position: c.chunkIndex, embedding: embeddings[i] ?? null }));
      if (entry) entry.chunks = chunks;
    }

    const qRes: any = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: [question] });
    const qVec: number[] | undefined = qRes?.ok ? qRes.embeddings?.[0] : undefined;
    if (!qVec) throw new Error('no query embedding');

    // Vectors are normalized → dot product = cosine similarity
    const scored = chunks
      .filter(c => c.embedding)
      .map(c => ({ c, score: c.embedding!.reduce((sum, v, i) => sum + v * qVec[i], 0) }))
      .sort((a, b) => b.score - a.score);

    const picked: PageChunkEmb[] = [];
    let used = 0;
    for (const { c } of scored) {
      if (used + c.text.length > PAGE_RETRIEVAL_BUDGET) continue;
      picked.push(c);
      used += c.text.length;
      if (used > PAGE_RETRIEVAL_BUDGET * 0.9) break;
    }
    if (picked.length === 0) throw new Error('no chunks selected');

    // Reading order, with elision markers between non-adjacent sections
    picked.sort((a, b) => a.position - b.position);
    let out = '[Only the sections most relevant to the question are shown]\n\n';
    let lastPos = -2;
    for (const c of picked) {
      if (lastPos >= 0 && c.position > lastPos + 1) out += '\n\n[…]\n\n';
      else if (lastPos >= 0) out += '\n\n';
      out += c.text;
      lastPos = c.position;
    }
    return out;
  } catch (e) {
    console.warn('Page retrieval mode failed, falling back to truncation', e);
    return md.slice(0, Math.floor(MAX_PAGE_CHARS * 0.7)) +
      '\n\n[... middle of the page truncated ...]\n\n' +
      md.slice(-Math.floor(MAX_PAGE_CHARS * 0.3));
  }
}

async function getPageContext(): Promise<PageContext | null> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return null;

  const cached = pageContextCache.get(tab.url);
  if (cached && Date.now() - cached.ts < PAGE_CONTEXT_TTL_MS) return cached.ctx;

  let ctx: PageContext | null = null;
  const looksPdf = /\.pdf($|\?)/i.test(tab.url);

  if (!looksPdf) {
    // Articles, YouTube transcripts, anything the content script can read
    const scraped = await scrapeTabViaContentScript(tab);
    if (scraped?.markdown) {
      ctx = { title: scraped.title, url: tab.url, markdown: scraped.markdown };
    }
  }

  if (!ctx && (looksPdf || await urlIsPdf(tab.url))) {
    // Scrape-only PDF path — parse locally, never save
    try {
      const body = await pdfUrlToBody(tab.url, imageToText);
      {
        if (body.replace(/## Page \d+/g, '').trim().length >= 50) {
          ctx = { title: tab.title || tab.url, url: tab.url, markdown: body };
        }
      }
    } catch (e) {
      console.warn('Page-context PDF parse failed', e);
    }
    if (!ctx) {
      try {
        const md = await fetchViaJina(tab.url);
        if (md.trim().length >= 50) ctx = { title: tab.title || tab.url, url: tab.url, markdown: md };
      } catch { /* no page context available */ }
    }
  }

  if (ctx) pageContextCache.set(tab.url, { ctx, ts: Date.now() });
  return ctx;
}

async function captureTab(tab: chrome.tabs.Tab, explicitProjectId: string | null): Promise<Record<string, unknown>> {
  if (!tab.id || !tab.url) throw new Error('No tab to capture.');

  if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
    throw new Error('Can only capture http/https pages.');
  }

  const linkTarget = await resolveLinkTarget(explicitProjectId);

  // PDF pages can't be read by the content script (PDF viewer has no article DOM).
  // URLs ending in .pdf are the obvious case; extension-less PDF URLs
  // (e.g. arxiv.org/pdf/2607.07708) are caught below via content-type.
  if (/\.pdf($|\?)/i.test(tab.url)) {
    return capturePdfUrl(linkTarget, tab);
  }

  // Execute the content script to scrape the page
  const scraped = await scrapeTabViaContentScript(tab);

  if (!scraped?.markdown) {
    // Chrome's PDF viewer blocks content scripts entirely — a PDF served
    // without a .pdf extension lands here. Check the content type.
    if (await urlIsPdf(tab.url)) {
      return capturePdfUrl(linkTarget, tab);
    }
    throw new Error('Could not extract content from this page.');
  }

  // Build markdown with Obsidian-compatible frontmatter
  const now = new Date().toISOString();
  const wordCount = scraped.wordCount || scraped.markdown.split(/\s+/).length;
  const fullMarkdown =
    buildFrontmatter({
      title: scraped.title,
      type: scraped.kind === 'youtube' ? 'youtube' : 'web-capture',
      source: scraped.url,
      author: scraped.author,
      captured: now,
      wordCount
    }) +
    scraped.markdown;

  // Generate a temporary ID for the doc short ID
  const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
  const docShortId = makeDocShortId(tempId);

  // Chunk the content
  const chunks = chunkDocument({
    docShortId,
    content: fullMarkdown
  });

  // Save to IndexedDB globally (always), then link if there's a target
  const { id: docId, chunks: savedChunks } = await saveDocument({
    title: scraped.title,
    url: scraped.url,
    content: fullMarkdown,
    capturedAt: now,
    favicon: scraped.favicon || tab.favIconUrl || '',
    wordCount,
    syncedToDrive: false
  }, chunks);

  if (linkTarget) {
    await linkDocumentToProject(linkTarget, docId);
    // Add to vector store (chunks now carry their final id + docId)
    await addChunksToVectorStore(linkTarget, savedChunks);
  }

  return { docId, title: scraped.title, chunkCount: chunks.length, linkedTo: linkTarget };
}

/**
 * Import local .md files read via the File System Access API in the sidepanel.
 * Images are already inlined as data: URLs by the sidepanel before sending.
 */
async function handleImportLocalMd(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  const files = request.files as Array<{ name: string; content: string }>;
  if (!projectId) throw new Error('projectId is required to import markdown');
  if (!Array.isArray(files) || files.length === 0) throw new Error('No files provided');

  let imported = 0;
  const errors: string[] = [];

  for (const file of files) {
    try {
      const title = file.name.replace(/\.(md|markdown)$/i, '');
      const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
      const docShortId = makeDocShortId(tempId);
      // Chunk a version with data URLs stripped so base64 blobs never end up
      // in the search index or LLM context. Full content (with images) is
      // still stored on the document for viewing.
      const wordCount = file.content.replace(/\(data:[^)]+\)/g, '').split(/\s+/).filter(Boolean).length;
      // Keep existing frontmatter (Obsidian notes etc.); add ours when absent
      const content = hasFrontmatter(file.content)
        ? file.content
        : buildFrontmatter({ title, type: 'local-import', source: 'local-file', wordCount }) + file.content;
      const visibleText = content.replace(/\(data:[^)]+\)/g, '(embedded-image)');
      const chunks = chunkDocument({ docShortId, content: visibleText });

      const { id: docId, chunks: savedChunks } = await saveDocument({
        title,
        url: '',
        content,
        capturedAt: new Date().toISOString(),
        favicon: '',
        wordCount,
        syncedToDrive: false
      }, chunks);

      await linkDocumentToProject(projectId, docId);
      await addChunksToVectorStore(projectId, savedChunks);
      imported++;
    } catch (err) {
      errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported, total: files.length, errors };
}

// ── PDF/HTML offscreen helper — delegates to lib/pdf-parser ──
// Re-export as a local alias so existing call-sites don't need updating.
const ensureOffscreen = ensureOffscreenDoc;

/** Does this URL serve a PDF? Checked via HEAD when the URL has no .pdf extension. */
async function urlIsPdf(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return (res.headers.get('content-type') || '').includes('application/pdf');
  } catch {
    return false;
  }
}

/**
 * Capture a PDF tab: fetch the bytes and parse locally with pdf.js
 * (works for arxiv.org/pdf/... and other extension-less PDF URLs).
 * Jina Reader is the network fallback if local parsing yields nothing.
 */
async function capturePdfUrl(projectId: string | null, tab: chrome.tabs.Tab): Promise<Record<string, unknown>> {
  const url = tab.url!;
  let body = '';

  try {
    body = await pdfUrlToBody(url, imageToText);
  } catch (e) {
    console.warn('Local PDF parse failed, falling back to Jina Reader', e);
  }

  const textOnly = body.replace(/## Page \d+/g, '').replace(/\*\(no extractable text\)\*/g, '').trim();
  if (textOnly.length < 50) {
    const md = await fetchViaJina(url);
    if (!md || md.trim().length < 50) {
      throw new Error('Could not extract text from this PDF (it may be scanned — try Import PDF instead).');
    }
    body = md;
  }

  const now = new Date().toISOString();
  const nameFromUrl = decodeURIComponent(url.split('/').pop() || 'PDF').replace(/\.pdf.*$/i, '');
  // Chrome's PDF viewer usually puts the filename or document title in tab.title
  const title = (tab.title && tab.title.trim() && tab.title !== url)
    ? tab.title.replace(/\.pdf$/i, '').trim()
    : nameFromUrl;

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const fullMarkdown = buildFrontmatter({ title, type: 'pdf', source: url, captured: now, wordCount }) + body;
  const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
  const chunks = chunkDocument({ docShortId: makeDocShortId(tempId), content: fullMarkdown });
  const { id: docId, chunks: savedChunks } = await saveDocument({
    title, url, content: fullMarkdown, capturedAt: now,
    favicon: tab.favIconUrl || '', wordCount, syncedToDrive: false
  }, chunks);
  if (projectId) {
    await linkDocumentToProject(projectId, docId);
    await addChunksToVectorStore(projectId, savedChunks);
  }
  return { docId, title, chunkCount: chunks.length, linkedTo: projectId };
}

/** Save one processed document (text) into IndexedDB + vector store + project. */
async function saveProcessedDoc(projectId: string, title: string, content: string): Promise<void> {
  const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
  const docShortId = makeDocShortId(tempId);
  const chunks = chunkDocument({ docShortId, content });
  const { id: docId, chunks: savedChunks } = await saveDocument({
    title,
    url: '',
    content,
    capturedAt: new Date().toISOString(),
    favicon: '',
    wordCount: content.split(/\s+/).filter(Boolean).length,
    syncedToDrive: false
  }, chunks);
  await linkDocumentToProject(projectId, docId);
  await addChunksToVectorStore(projectId, savedChunks);
}

/**
 * Import local PDFs: extract text by CODE first (pdf.js in the offscreen doc).
 * Scanned pages with no extractable text fall back to the vision model (OCR).
 */
async function handleImportLocalPdf(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  const files = request.files as Array<{ name: string; base64: string }>;
  if (!projectId) throw new Error('projectId is required');
  if (!Array.isArray(files) || files.length === 0) throw new Error('No PDF files provided');

  // Process asynchronously — return immediately so the UI is not blocked
  const processAsync = async () => {
    await ensureOffscreen();
    let imported = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        const title = file.name.replace(/\.pdf$/i, '');
        // Notify UI that we're starting this file
        notifyImportProgress({ type: 'pdf-progress', file: file.name, status: 'parsing', imported, total: files.length });
        const body = await pdfBase64ToBody(file.base64, imageToText);
        const content = buildFrontmatter({
          title, type: 'pdf', source: 'local-pdf',
          wordCount: body.split(/\s+/).filter(Boolean).length
        }) + body;
        await saveProcessedDoc(projectId, title, content);
        imported++;
        notifyImportProgress({ type: 'pdf-progress', file: file.name, status: 'done', imported, total: files.length });
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        notifyImportProgress({ type: 'pdf-progress', file: file.name, status: 'error', error: err instanceof Error ? err.message : String(err), imported, total: files.length });
      }
    }
    // Final notification
    notifyImportProgress({ type: 'pdf-complete', imported, total: files.length, errors });
    notifySidepanelSync();
  };

  // Fire and forget — don't await
  processAsync().catch(err => console.error('Async PDF import failed:', err));

  return { accepted: true, total: files.length };
}

/** Notify the side panel of import progress via BroadcastChannel */
function notifyImportProgress(data: Record<string, unknown>) {
  try {
    const ch = new BroadcastChannel('ai_research_assistant_import');
    ch.postMessage(data);
    ch.close();
  } catch { /* BroadcastChannel not available */ }
}

/** Import local images: turn each into text via the vision model (OCR/describe). */
async function handleImportLocalImages(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  const files = request.files as Array<{ name: string; dataUrl: string }>;
  if (!projectId) throw new Error('projectId is required');
  if (!Array.isArray(files) || files.length === 0) throw new Error('No images provided');

  // Process asynchronously — return immediately so the UI is not blocked
  const processAsync = async () => {
    let imported = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        notifyImportProgress({ type: 'image-progress', file: file.name, status: 'processing', imported, total: files.length });
        const raw = await imageToText(file.dataUrl);

        // Parse AI-generated title from the response (first line: "TITLE: ...")
        let title: string;
        let body: string;
        const titleMatch = raw.match(/^TITLE:\s*(.+)/i);
        if (titleMatch) {
          title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
          body = raw.slice(titleMatch[0].length).replace(/^[\s-]+/, '').trim();
        } else {
          // Fallback: use first heading, first sentence, or filename
          const headingMatch = raw.match(/^#+\s+(.+)/m);
          const sentenceMatch = raw.match(/^([A-Z][^.!?]{10,80}[.!?])/m);
          title = headingMatch?.[1]
            || sentenceMatch?.[1]
            || raw.slice(0, 60).replace(/\s+/g, ' ').trim()
            || file.name.replace(/\.(png|jpe?g|gif|webp|avif)$/i, '');
          body = raw;
        }
        // Truncate overly long titles
        if (title.length > 80) title = title.slice(0, 77) + '...';

        // Embed the original image as a data URL so it's visible in DocumentView
        const content = buildFrontmatter({
          title, type: 'image', source: 'local-image',
          wordCount: body.split(/\s+/).filter(Boolean).length
        }) + `![${title}](${file.dataUrl})\n\n---\n\n${body}`;
        await saveProcessedDoc(projectId, title, content);
        imported++;
        notifyImportProgress({ type: 'image-progress', file: file.name, status: 'done', imported, total: files.length });
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        notifyImportProgress({ type: 'image-progress', file: file.name, status: 'error', error: err instanceof Error ? err.message : String(err), imported, total: files.length });
      }
    }
    notifyImportProgress({ type: 'image-complete', imported, total: files.length, errors });
    notifySidepanelSync();
  };

  processAsync().catch(err => console.error('Async image import failed:', err));
  return { accepted: true, total: files.length };
}


// ── Re-index library: re-chunk with the current chunker + embed everything ──
let reindexRunning = false;

async function handleReindexLibrary(): Promise<Record<string, unknown>> {
  if (reindexRunning) return { success: false, error: 'Re-index already running' };
  reindexRunning = true;
  // Fire-and-forget: progress streams over the import channel; the response
  // returns immediately so the UI doesn't block on a long walk.
  void (async () => {
    const ch = new BroadcastChannel('ai_research_assistant_import');
    // MV3 keep-alive — a large library takes minutes to re-embed
    const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo?.().catch(() => {}); }, 20000);
    try {
      const docs = await listDocuments();
      let done = 0;
      for (const doc of docs) {
        try {
          if (!doc.content) { done++; continue; }
          const raw = chunkDocument({ docShortId: makeDocShortId(doc.id), content: doc.content });
          let embeddings: (number[] | undefined)[] = [];
          try {
            const res: any = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: raw.map(c => c.text) });
            if (res?.ok && Array.isArray(res.embeddings)) embeddings = res.embeddings;
          } catch { /* vectorless chunks are valid — BM25 still works */ }
          const withVecs = raw.map((c, i) => ({ ...c, embedding: embeddings[i] }));
          await replaceChunksForDoc(doc.id, withVecs);
          done++;
          ch.postMessage({ type: 'reindex-progress', done, total: docs.length, title: doc.title });
        } catch (e: any) {
          ch.postMessage({ type: 'reindex-progress', done, total: docs.length, title: doc.title, error: e.message });
        }
        await new Promise(r => setTimeout(r, 0)); // keep message handlers responsive
      }
      // Every in-memory index now holds stale chunk ids — drop them all;
      // they rehydrate from IndexedDB on the next search.
      resetAllSessionIndexes();
      ch.postMessage({ type: 'reindex-complete', done, total: docs.length });
    } finally {
      clearInterval(keepAlive);
      reindexRunning = false;
      ch.close();
    }
  })();
  return { success: true, started: true };
}


// ─────────────────────────────────────────────
// Cancellation Handler
// ─────────────────────────────────────────────
async function handleCancelTask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const chatId = request.chatId as string | undefined;
  const projectId = request.projectId as string | undefined;
  
  if (chatId && abortControllers.has(chatId)) {
    abortControllers.get(chatId)?.abort();
    abortControllers.delete(chatId);
  }
  if (projectId && abortControllers.has(projectId)) {
    abortControllers.get(projectId)?.abort();
    abortControllers.delete(projectId);
  }
  return {};
}

// ─────────────────────────────────────────────
// Chat Handler — Source-Grounded with Citations
// ─────────────────────────────────────────────

/** Build the RAG system prompt + formatted history for a chat turn. */
async function buildChatRequest(chatId: string, projectId: string, prompt: string, pageContext?: PageContext | null): Promise<{ systemPrompt: string; formattedHistory: Array<{ role: string; content: string }> }> {
  // Get all documents for this project
  const allDocs = await listDocuments(projectId);
  const enabledDocs = allDocs.filter(d => d.enabled !== false);
  const docIds = enabledDocs.map(d => d.id);
  const docTitles = new Map(enabledDocs.map(d => [d.id, d.title]));

  console.log(`[RAG] Project ${projectId}: ${enabledDocs.length} enabled docs, ${docIds.length} IDs`);

  // ── Multi-Query Adaptive RAG ──
  // 1. Initial search with the user's exact query
  // 2. If results are sparse, expand the query using the LLM into 2-3 variants
  // 3. Search each variant and merge results
  let relevantChunks: any[] = [];
  if (docIds.length > 0) {
    relevantChunks = await searchSessionChunks(projectId, prompt, 25, docIds);
    console.log(`[RAG] Initial search for "${prompt.slice(0, 50)}..." returned ${relevantChunks.length} chunks`);

    // Adaptive multi-query: only expand when initial results are sparse
    if (relevantChunks.length < 5 && prompt.length > 10) {
      try {
        const expandedQueries = await expandQuery(prompt);
        if (expandedQueries.length > 0) {
          console.log(`[RAG] Expanding query into ${expandedQueries.length} variants:`, expandedQueries);
          const existingIds = new Set(relevantChunks.map(c => c.id));

          for (const variant of expandedQueries) {
            const variantChunks = await searchSessionChunks(projectId, variant, 10, docIds);
            for (const chunk of variantChunks) {
              if (!existingIds.has(chunk.id)) {
                relevantChunks.push(chunk);
                existingIds.add(chunk.id);
              }
            }
          }
          console.log(`[RAG] After multi-query expansion: ${relevantChunks.length} total chunks`);
        }
      } catch (e) {
        console.warn('[RAG] Query expansion failed, using initial results:', e);
      }
    }

    // Fallback: search using document titles if still too few
    if (relevantChunks.length < 3 && enabledDocs.length > 0) {
      const existingIds = new Set(relevantChunks.map(c => c.id));
      for (const doc of enabledDocs.slice(0, 3)) {
        const titleChunks = await searchSessionChunks(projectId, doc.title, 5, docIds);
        for (const chunk of titleChunks) {
          if (!existingIds.has(chunk.id)) {
            relevantChunks.push(chunk);
            existingIds.add(chunk.id);
          }
        }
        if (relevantChunks.length >= 15) break;
      }
      if (relevantChunks.length > 3) {
        console.log(`[RAG] Title-based fallback found ${relevantChunks.length} total chunks`);
      }
    }
  }

  let systemPrompt: string;

  if (relevantChunks.length > 0) {
    // Build citation-anchored context
    const context = buildCitationContext(relevantChunks, docTitles, 25000);

    // We add strict anti-hallucination prompts to the system prompt
    systemPrompt = CITATION_SYSTEM_PROMPT +
      `\nCRITICAL ANTI-HALLUCINATION RULE: If the answer cannot be found in the provided sources, you MUST say "I cannot answer this based on the provided sources." DO NOT rely on external knowledge.\n` +
      `\n--- SOURCES ---\n${context}\n--- END SOURCES ---`;
  } else {
    console.warn(`[RAG] No chunks found for project ${projectId} — falling back to general knowledge`);
    // General conversation fallback
    systemPrompt = `You are a helpful AI assistant. No relevant documents were found in the user's research workspace for this question. ` +
      `Begin your answer with this exact italic line: *No matching sources in this workspace — answering from general knowledge.* ` +
      `Then answer using your general knowledge. Do not fabricate citations.`;
  }

  // Retrieve history BEFORE saving the new user message
  const history = await getChatHistory(chatId);
  const formattedHistory = history
    .filter((msg: any) => msg.role === 'user' || msg.role === 'assistant')
    .map((msg: any) => ({ role: msg.role, content: msg.text }));

  // Ephemeral page context: the tab the user is looking at right now.
  // Deliberately fenced off from library sources — it has no citation
  // anchors and is never persisted.
  if (pageContext) {
    // Long pages switch to per-question retrieval (see selectPageMarkdown)
    const md = await selectPageMarkdown(pageContext, prompt);
    systemPrompt +=
      `\n\n--- CURRENT PAGE (the user is viewing this in their browser right now; it is NOT saved in their library) ---\n` +
      `Title: ${pageContext.title}\nURL: ${pageContext.url}\n\n${md}\n` +
      `--- END CURRENT PAGE ---\n` +
      `You may answer from the current page. Attribute such claims in plain text, e.g. "according to the page you're viewing". ` +
      `NEVER use [anchor] citations for current-page content — anchors are only for library sources.`;
  }

  return { systemPrompt, formattedHistory };
}

/**
 * Use the LLM to expand a user query into 2-3 search reformulations.
 * This catches synonym mismatches, misspellings, and conceptual gaps.
 */
async function expandQuery(userQuery: string): Promise<string[]> {
  const { apiKey, endpoint, model } = await getProviderSettings();
  if (!endpoint || !model) return [];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: `Generate exactly 3 alternative search queries for finding relevant information about: "${userQuery}"

Rules:
- Fix any spelling mistakes in the original query
- Use synonyms and related terms
- Rephrase from different angles
- Keep each query short (under 10 words)
- Output ONLY the 3 queries, one per line, no numbering, no explanation`
      }],
      temperature: 0.3,
      max_tokens: 150
    })
  });

  if (!res.ok) return [];
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  return content
    .split('\n')
    .map((line: string) => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter((line: string) => line.length > 3 && line.length < 100)
    .slice(0, 3);
}

async function handleChat(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prompt = request.prompt as string;
  const chatId = request.chatId as string;
  const projectId = request.projectId as string;

  if (!chatId || !projectId) throw new Error('chatId and projectId are required for chat');

  const controller = new AbortController();
  abortControllers.set(chatId, controller);
  const signal = controller.signal;

  try {
    const pageCtx = request.includePageContext ? await getPageContext().catch(() => null) : null;
    const { systemPrompt, formattedHistory } = await buildChatRequest(chatId, projectId, prompt, pageCtx);

    // Persist the user message immediately so it survives errors/reloads
    await saveChatMessage({
      chatId,
      role: 'user',
      text: prompt,
      timestamp: new Date().toISOString(),
      provider: 'custom'
    });

    const reply = await chatWithCustom(systemPrompt, formattedHistory, prompt, signal);

    await saveChatMessage({
      chatId,
      role: 'assistant',
      text: reply,
      timestamp: new Date().toISOString(),
      provider: 'custom'
    });

    return { reply };
  } finally {
    abortControllers.delete(chatId);
  }
}

// ─────────────────────────────────────────────
// Streaming Chat — long-lived port from the sidepanel
// ─────────────────────────────────────────────
// The open port also keeps the MV3 service worker alive while tokens flow.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat-stream') return;

  let controller: AbortController | null = null;
  let disconnected = false;

  const safePost = (m: Record<string, unknown>) => {
    if (disconnected) return;
    try { port.postMessage(m); } catch { disconnected = true; }
  };

  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller?.abort();
  });

  port.onMessage.addListener(async (req) => {
    if (req?.type !== 'START') return;
    const prompt = req.prompt as string;
    const chatId = req.chatId as string;
    const projectId = req.projectId as string;
    const systemPromptOverride = req.systemPromptOverride as string | undefined;
    if (!prompt || !chatId || !projectId) {
      safePost({ type: 'ERROR', error: 'prompt, chatId and projectId are required' });
      return;
    }

    controller = new AbortController();
    abortControllers.set(chatId, controller);
    let full = '';

    try {
      const pageCtx = req.includePageContext ? await getPageContext().catch(() => null) : null;
      let { systemPrompt, formattedHistory } = await buildChatRequest(chatId, projectId, prompt, pageCtx);

      // If a slash command provides a systemPromptOverride, prepend it
      if (systemPromptOverride) {
        systemPrompt = systemPromptOverride + '\n\n' + systemPrompt;
      }

      await saveChatMessage({
        chatId,
        role: 'user',
        text: prompt,
        timestamp: new Date().toISOString(),
        provider: 'custom'
      });

      await chatWithCustomStream(systemPrompt, formattedHistory, prompt, controller.signal, (delta) => {
        full += delta;
        safePost({ type: 'DELTA', text: delta });
      });

      if (full.trim()) {
        await saveChatMessage({
          chatId,
          role: 'assistant',
          text: full,
          timestamp: new Date().toISOString(),
          provider: 'custom'
        });
      }
      safePost({ type: 'DONE', fullText: full });
    } catch (err) {
      const aborted = controller.signal.aborted;
      // Keep whatever streamed in before the stop/error
      if (full.trim()) {
        await saveChatMessage({
          chatId,
          role: 'assistant',
          text: full + (aborted ? '\n\n*(stopped)*' : ''),
          timestamp: new Date().toISOString(),
          provider: 'custom'
        }).catch(() => {});
      }
      if (aborted) {
        safePost({ type: 'DONE', fullText: full });
      } else {
        safePost({ type: 'ERROR', error: String(err instanceof Error ? err.message : err) });
      }
    } finally {
      if (abortControllers.get(chatId) === controller) abortControllers.delete(chatId);
    }
  });
});

async function handleGetChatHistory(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const chatId = request.chatId as string;
  const messages = await getChatHistory(chatId);
  return { messages };
}

async function handleClearChatHistory(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const chatId = request.chatId as string;
  await clearChatHistory(chatId);
  return {};
}

// ─────────────────────────────────────────────
// Deep Researcher Handlers
// ─────────────────────────────────────────────
/**
 * Make a research request self-contained. Users type things like
 * "/deepresearch what is the best way to use these information" — "these"
 * refers to the conversation or workspace docs, which the web-search planner
 * can't see. Resolve such references with one small LLM call.
 */
async function resolveResearchTopic(
  topic: string,
  chatId: string | undefined,
  projectId: string,
  chatFn: (s: string, u: string) => Promise<string>
): Promise<string> {
  const history = chatId ? await getChatHistory(chatId) : [];
  const recent = history
    .filter((m: any) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m: any) => `${m.role}: ${String(m.text).slice(0, 400)}`)
    .join('\n');
  const docs = await listDocuments(projectId);
  const titles = docs.filter(d => d.enabled !== false).slice(0, 10).map(d => d.title).join('; ');

  if (!recent && !titles) return topic;

  const res = await chatFn(
    `You rewrite a user's research request into ONE self-contained, web-searchable research topic. The request may reference the conversation or the user's workspace documents ("these", "this model", "the above"). Resolve those references using the provided context. Return ONLY the rewritten topic as a single sentence — no quotes, no explanation. If the request is already self-contained, return it unchanged.`,
    `Workspace documents: ${titles || '(none)'}\n\nRecent conversation:\n${recent || '(none)'}\n\nResearch request: ${topic}`
  );

  const cleaned = res.trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
  return (cleaned.length > 5 && cleaned.length < 300) ? cleaned : topic;
}

async function handleDeepResearch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { projectId, topic, chatId } = request;
  const mode = (request.mode as 'quick' | 'deep') || 'quick';
  if (!projectId || !topic) throw new Error('projectId and topic are required');

  const chatFn = (s: string, u: string) => chatWithCustom(s, [], u);

  // Persist the command in chat history so the conversation survives reloads
  if (chatId) {
    await saveChatMessage({
      chatId: chatId as string,
      role: 'user',
      text: `${mode === 'deep' ? '/deepresearch' : '/research'} ${topic}`,
      timestamp: new Date().toISOString(),
      provider: 'custom'
    });
  }

  // Resolve conversational references into a standalone topic
  let effectiveTopic = topic as string;
  try {
    effectiveTopic = await resolveResearchTopic(topic as string, chatId as string | undefined, projectId as string, chatFn);
  } catch (e) {
    console.warn('Topic resolution failed, using raw topic', e);
  }

  // Checkpoint the job so a worker/browser death can resume it
  await startResearchJob({
    projectId: projectId as string,
    chatId: chatId as string | undefined,
    topic: topic as string,
    effectiveTopic,
    mode
  }).catch(() => {});

  // Mark the job as actively running BEFORE starting executeResearch.
  // resumePendingResearch will only resume jobs marked active, preventing
  // spurious re-execution of jobs that haven't started yet.
  await markJobActive().catch(() => {});

  return executeResearch({
    projectId: projectId as string,
    chatId: chatId as string | undefined,
    topic: topic as string,
    effectiveTopic,
    mode
  });
}

interface ResearchParams {
  projectId: string;
  chatId?: string;
  topic: string;
  effectiveTopic: string;
  mode: 'quick' | 'deep';
}

/** Run (or resume) a research job. Job checkpoint must already exist. */
async function executeResearch({ projectId, chatId, topic, effectiveTopic, mode }: ResearchParams): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  abortControllers.set(projectId, controller);
  const signal = controller.signal;

  const chatFn = (s: string, u: string) => chatWithCustom(s, [], u, signal);

  // Streaming synthesis: forward coalesced deltas so the panel renders the
  // report live during [SYNTHESIZING]. Deltas are droppable — the persisted
  // chat message written after completion is the source of truth.
  const synthesisFn = async (sys: string, user: string): Promise<string> => {
    let full = '';
    try {
      await chatWithCustomStream(sys, [], user, signal, (delta) => {
        full += delta;
        chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_DELTA', projectId, delta }).catch(() => {});
      });
    } catch (e) {
      if (full.length === 0) throw e;
      // Partial stream then failure: fall back to non-streaming call
      return chatFn(sys, user);
    }
    return full;
  };
  const onProgress = (status: string) => {
    chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_LOG', projectId, status }).catch(() => {});
    appendJobLog(status).catch(() => {});
  };

  if (effectiveTopic !== topic) {
    onProgress(`[PLANNING] Interpreted request as: "${effectiveTopic}"`);
  }

  // Keep-alive heartbeat: call chrome.runtime.getPlatformInfo() every 20s to reset
  // the MV3 worker's 30s idle timeout while research is active. This prevents
  // the worker from being killed mid-LLM-call during long synthesis/planning phases.
  // Also updates lastHeartbeatAt so resumePendingResearch can tell apart a
  // genuinely interrupted job (stale heartbeat) from one whose clearJob write
  // lost a race with a worker death (fresh heartbeat → skip resume).
  const heartbeatInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo?.().catch(() => {});
    updateHeartbeat().catch(() => {});
  }, 20000);

  try {
    const result = await runDeepResearch(projectId, effectiveTopic, chatFn, onProgress, signal, mode, synthesisFn);

    // Persist the synthesis as an assistant message — this is what keeps
    // the chat session intact after research finishes.
    if (chatId) {
      const sourcesList = [...new Set(result.sources)].map(s => `- ${s}`).join('\n');
      const interpretedNote = effectiveTopic !== topic ? `*Interpreted as: "${effectiveTopic}"*\n\n` : '';
      // Truncate the heading topic to keep the report title readable
      const headingTopic = topic.length > 120 ? topic.slice(0, 117) + '…' : topic;
      await saveChatMessage({
        chatId,
        role: 'assistant',
        text: `## Deep Research: ${headingTopic}\n\n${interpretedNote}${result.synthesis}\n\n### Sources Used\n${sourcesList}`,
        timestamp: new Date().toISOString(),
        provider: 'custom'
      });
    }

    // Mark finished before clearing — if clearJob's storage write loses a race
    // with a worker death, the active:false flag prevents a spurious auto-resume.
    await markJobFinished().catch(() => {});
    await clearResearchJob().catch(() => {});
    return { success: true, synthesis: result.synthesis, sources: result.sources };
  } catch (err: any) {
    const message = err.message === 'AbortError' ? 'Cancelled' : err.message;
    if (chatId) {
      await saveChatMessage({
        chatId,
        role: 'system',
        text: `Deep research failed: ${message}`,
        timestamp: new Date().toISOString(),
        provider: 'custom'
      }).catch(() => {});
    }
    // Handled failure/cancel — do not auto-retry on next startup
    await markJobFinished().catch(() => {});
    await clearResearchJob().catch(() => {});
    return { success: false, error: message };
  } finally {
    clearInterval(heartbeatInterval);
    abortControllers.delete(projectId);
    // Evict the in-memory Orama index for this session; persisted documents
    // (source pages + synthesis report) rehydrate from IDB on the next search.
    resetSessionIndex(projectId);
    chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_DONE', projectId }).catch(() => {});
    notifySidepanelSync();
  }
}

// ── Auto-resume: a job left behind means the worker/browser died mid-run ──
let resumeChecked = false;
async function resumePendingResearch(): Promise<void> {
  if (resumeChecked) return;
  resumeChecked = true;
  try {
    const job = await getResearchJob();
    if (!job) return;

    console.log('[Research Diagnostics] Detected pending job:', job);

    // Gate 1: job must be marked active (set at run start, cleared at run end).
    // Non-active jobs are either brand-new (executeResearch hasn't started yet)
    // or finished ones whose clearJob raced with a worker death.
    if (!job.active) {
      console.log('[Research Diagnostics] Job not marked active — clearing stale record');
      await clearResearchJob().catch(() => {});
      return;
    }

    // Gate 2: heartbeat staleness check.
    // A fresh heartbeat (< HEARTBEAT_STALE_MS) means the run very recently
    // completed and clearJob just lost a race — skip resume and clean up.
    if (job.lastHeartbeatAt && Date.now() - job.lastHeartbeatAt < HEARTBEAT_STALE_MS) {
      console.log('[Research Diagnostics] Heartbeat is fresh — job likely just finished, clearing record');
      await clearResearchJob().catch(() => {});
      return;
    }

    if (abortControllers.has(job.projectId)) return; // already running in this instance
    if (Date.now() - new Date(job.startedAt).getTime() > JOB_MAX_AGE_MS) {
      await clearResearchJob();
      return;
    }

    // Resume attempt cap: if this job has been resumed more than 3 times,
    // it's stuck in a loop — clear it and send a failure message.
    const attemptCount = await incrementResumeAttempts();
    if (attemptCount > 3) {
      const message = `Research failed: Job repeatedly interrupted and could not complete. This typically indicates a very long-running LLM request (synthesis/planning) that exceeds Chrome's worker idle timeout. Try a simpler topic or split into smaller queries.`;
      if (job.chatId) {
        await saveChatMessage({
          chatId: job.chatId,
          role: 'system',
          text: message,
          timestamp: new Date().toISOString(),
          provider: 'custom'
        }).catch(() => {});
      }
      await clearResearchJob();
      return;
    }

    chrome.runtime.sendMessage({
      action: 'DEEP_RESEARCH_LOG',
      projectId: job.projectId,
      status: `[RESUME] Interrupted research detected — resuming from checkpoint (attempt ${attemptCount})…`
    }).catch(() => {});
    await appendJobLog(`[RESUME] Interrupted research detected — resuming from checkpoint (attempt ${attemptCount})…`).catch(() => {});
    await executeResearch({
      projectId: job.projectId,
      chatId: job.chatId,
      topic: job.topic,
      effectiveTopic: job.effectiveTopic,
      mode: job.mode
    });
  } catch (e) {
    console.warn('Research resume failed', e);
  }
}
// Give the worker a moment to settle, then check for an interrupted job.
setTimeout(() => { void resumePendingResearch(); }, 2000);

// ─────────────────────────────────────────────
// AI Provider Implementations
// ─────────────────────────────────────────────


// ── Provider Settings Helper ──

// ── Jina Reader: free web/PDF → markdown (no API key) ──
async function fetchViaJina(url: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { 'Accept': 'text/plain' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`Reader error ${res.status}`);
  const md = (await res.text()).trim();
  const bodyIdx = md.indexOf('Markdown Content:');
  return bodyIdx !== -1 ? md.slice(bodyIdx + 'Markdown Content:'.length).trim() : md;
}

// ── Vision: image → text (OCR / description) ──
// Uses the same OpenAI-compatible endpoint with the configured vision model.
async function imageToText(dataUrl: string, instruction?: string): Promise<string> {
  const { apiKey, endpoint, visionModel, model } = await getProviderSettings();
  if (!endpoint) throw new Error('Set an API Base URL in Settings first.');
  const useModel = visionModel || model;
  if (!useModel) throw new Error('Set a Vision Model in Settings first.');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: useModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruction || 'First, output a single line starting with "TITLE: " followed by a short descriptive title (max 60 chars) for this image. Then on the next line, transcribe ALL text in the image exactly. If there is no text, describe the image factually. Output plain text/markdown only.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Vision model error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Custom ──

// ─────────────────────────────────────────────
// Google Drive — Optional Sync
// ─────────────────────────────────────────────
function getToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome.identity?.getAuthToken) {
      reject(new Error('Google sign-in is not available. Grant the optional identity permission.'));
      return;
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Not authenticated'));
      } else {
        resolve(token);
      }
    });
  });
}

async function clearToken(): Promise<void> {
  try {
    const token = await getToken(false);
    await new Promise<void>((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
  } catch {
    // No token cached
  }
}

async function driveRequest(path: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive API ${res.status}: ${res.statusText}. ${body}`);
  }
  return res;
}

async function ensureFolder(token: string): Promise<string> {
  const storage = await chrome.storage.local.get(['driveFolderName', 'driveFolderId']);
  const folderName = storage.driveFolderName || 'Magpie';

// Brand import moved to top level removed here due to top-level import restriction

  if (storage.driveFolderId) {
    try {
      const checkRes = await driveRequest(
        `/drive/v3/files/${storage.driveFolderId}?fields=id,trashed`, token
      );
      const checkData = await checkRes.json();
      if (!checkData.trashed) return storage.driveFolderId;
    } catch {
      // fall through
    }
  }

  const q = encodeURIComponent(
    `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchRes = await driveRequest(`/drive/v3/files?q=${q}&fields=files(id)`, token);
  const searchData = await searchRes.json();

  if (searchData.files?.length > 0) {
    const id = searchData.files[0].id;
    await chrome.storage.local.set({ driveFolderId: id });
    return id;
  }

  const createRes = await driveRequest('/drive/v3/files', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' })
  });
  const createData = await createRes.json();
  await chrome.storage.local.set({ driveFolderId: createData.id });
  return createData.id;
}

async function uploadMarkdown(
  token: string,
  folderId: string,
  fileName: string,
  content: string
): Promise<string> {
  const boundary = '----MAGPIE_BOUNDARY';

// Brand import moved to top level removed here due to top-level import restriction
  const metadata = {
    name: fileName,
    mimeType: 'text/markdown',
    parents: [folderId]
  };

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: text/markdown; charset=UTF-8\r\n\r\n` +
    content +
    `\r\n--${boundary}--`;

  const res = await driveRequest('/upload/drive/v3/files?uploadType=multipart', token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  return data.id;
}

async function handleSyncToDrive(): Promise<Record<string, unknown>> {
  const token = await getToken(false);
  const folderId = await ensureFolder(token);
  const unsynced = await getUnsyncedDocuments();

  let synced = 0;
  const errors: string[] = [];

  for (const doc of unsynced) {
    try {
      const fileName = doc.title.replace(/[/\\?%*:|"<>]+/g, '-').substring(0, 120) + '.md';
      const driveFileId = await uploadMarkdown(token, folderId, fileName, doc.content);
      await updateDocumentSync(doc.id, true, driveFileId);
      synced++;
    } catch (err) {
      errors.push(`${doc.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { synced, total: unsynced.length, errors };
}

async function handleImportFromDrive(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await getToken(false);
  const folderId = await ensureFolder(token);
  const projectId = request.projectId as string;
  if (!projectId) throw new Error('projectId is required for importing');

  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await driveRequest(
    `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,createdTime)&orderBy=createdTime desc&pageSize=50`,
    token
  );
  const data = await res.json();
  const files = data.files || [];

  let imported = 0;

  for (const file of files) {
    try {
      const contentRes = await driveRequest(`/drive/v3/files/${file.id}?alt=media`, token);
      const content = await contentRes.text();

      const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
      const docShortId = makeDocShortId(tempId);
      const chunks = chunkDocument({ docShortId, content });

      const { id: docId, chunks: savedChunks } = await saveDocument({
        title: file.name?.replace(/\.md$/i, '') || 'Imported',
        url: '',
        content,
        capturedAt: file.createdTime || new Date().toISOString(),
        wordCount: content.split(/\s+/).length,
        syncedToDrive: true,
        driveFileId: file.id
      }, chunks);

      // Link into the project so it shows up in the session's source list
      await linkDocumentToProject(projectId, docId);
      await addChunksToVectorStore(projectId, savedChunks);

      imported++;
    } catch {
      // Skip files that fail to import
    }
  }

  return { imported, total: files.length };
}

async function handleListDriveFiles(): Promise<Record<string, unknown>> {
  const token = await getToken(false);
  const storage = await chrome.storage.local.get(['driveFolderId']);
  if (!storage.driveFolderId) return { files: [] };

  const q = encodeURIComponent(`'${storage.driveFolderId}' in parents and trashed=false`);
  const res = await driveRequest(
    `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,createdTime)&orderBy=createdTime desc&pageSize=50`,
    token
  );
  const data = await res.json();
  return { files: data.files || [] };
}

