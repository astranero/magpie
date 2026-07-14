// ─────────────────────────────────────────────
// Background Service Worker — AI Research Assistant v2
// ─────────────────────────────────────────────
// Local-first storage (IndexedDB), multi-provider AI,
// source-grounded citation prompts, optional Drive sync.

import {
  saveDocument, listDocuments, updateDocumentSync,
  getUnsyncedDocuments, getChatHistory, clearChatHistory, saveChatMessage,
  linkDocumentToProject, getProject,
  getChunkByAnchor, deleteOrphanDocuments
} from '../lib/db';
import { chunkDocument, makeDocShortId } from '../lib/chunker';
import { buildCitationContext, CITATION_SYSTEM_PROMPT, parseResponseCitations } from '../lib/citations';
import { buildFrontmatter, hasFrontmatter } from '../lib/frontmatter';
import { get as idbGet } from 'idb-keyval';
import { runDeepResearch, generateSubQuestions, scrapeUrl, isJunkUrl, gatherWebSnippets } from './deep-researcher';
import { harvestReferences } from '../lib/reference-harvest';
import { needsIntentResolution, formatHistoryForIntent, parseRepoUrl, selectTreePaths, formatTreeBlock, isChitchat, isRefusalAnswer, isStructureQuestion, isImplementationQuestion, findRepoUrlInText, isPageMetaQuestion, questionKeywords, mentionsPageDeixis, overlapsPage, isLocationDependent, timezoneToPlace, RepoRef } from '../lib/query-intent';
import { selectSemantic, fetchWithinBudget, parseRouterSelection, TOTAL_CTX_BUDGET, RerankFn, LinkRef, Selection } from '../lib/context-retrieval';
import { getResearchLimits } from '../lib/research-limits';
import { looksLikeBuildLog, extractLogHighlights } from '../lib/log-highlights';
import { addChunksToVectorStore, searchSessionChunks, resetSessionIndex, resetAllSessionIndexes, isConfidentMatch } from '../lib/vector-store';
import { replaceChunksForDoc } from '../lib/db';
import { pdfUrlToBody, pdfOpfsToBody, ensureOffscreen as ensureOffscreenDoc } from '../lib/pdf-parser';
import { setEnsureOffscreen, sendToOffscreen } from '../lib/offscreen-client';
import { getProviderSettings, chatWithCustom, chatWithCustomStream, handleFetchCustomModels, chatWithTools, ToolDef } from './llm-client';
import { handleSearchLibrary, handleRecallDocs } from './library-handlers';
import { handleLinkDocument, handleUnlinkDocument, handleListDocuments, handleGetDocument, handleDeleteDocument, handleGetDocumentCount, handleUpdateDocumentSelection } from './document-handlers';
import { handleCreateProject, handleListProjects, handleGetProject, handleUpdateProject, handleDeleteProject, handleCreateChat, handleListChats, handleDeleteChat, handleUpdateChat } from './project-handlers';
import {
  startJob as startResearchJob, getJob as getResearchJob,
  clearJob as clearResearchJob, appendJobLog, incrementResumeAttempts,
  markJobActive, markJobFinished, updateHeartbeat, JOB_MAX_AGE_MS, HEARTBEAT_STALE_MS
} from '../lib/research-store';

// ─────────────────────────────────────────────
// Robust error handling & offscreen management
// ─────────────────────────────────────────────

// Global unhandled rejection handler - catches silent failures
self.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  console.error('[SW] Unhandled rejection:', err?.message || err);
  // Prevent default browser behavior (which might kill the worker)
  event.preventDefault();
});

// Global error handler
self.addEventListener('error', (event) => {
  console.error('[SW] Global error:', event.message, event.filename, event.lineno);
});

// Offscreen document health tracking
let offscreenHealthCheckInterval: number | null = null;

// Register ensureOffscreen with the robust client for auto-recreation
setEnsureOffscreen(ensureOffscreenDoc);

// Start periodic offscreen health check (every 60s)
function startOffscreenHealthCheck() {
  if (offscreenHealthCheckInterval) return;
  offscreenHealthCheckInterval = self.setInterval(async () => {
    try {
      await sendToOffscreen({ action: 'OFFSCREEN_HEALTH_CHECK' });
    } catch {
      // Health check failed - will trigger recreation on next real request
      console.warn('[SW] Offscreen health check failed');
    }
  }, 60000);
}

// Call on startup
startOffscreenHealthCheck();

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
    // File System Access API requires a page context (user-gesture permission).
    // The service worker can never hold 'granted' file permissions — tell the
    // sidepanel to do the write instead via BroadcastChannel.
    notifySidepanelSync();
  }
});

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
        error: err instanceof Error ? err.message : err instanceof DOMException ? err.message : String(err)
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
  CLEANUP_ORPHANS: async () => {
    const deleted = await deleteOrphanDocuments();
    return { deleted };
  },

  // ── Chat ──
  CHAT_WITH_KNOWLEDGE: handleChat,
  GET_CHAT_HISTORY: handleGetChatHistory,
  CLEAR_CHAT_HISTORY: handleClearChatHistory,
  CANCEL_TASK: handleCancelTask,

  // ── Deep Research ──
  START_DEEP_RESEARCH: handleDeepResearch,
  PREVIEW_DEEP_RESEARCH: handlePreviewDeepResearch,
  REFINE_RESEARCH_PLAN: handleRefineResearchPlan,
  CREATE_SKILL: handleCreateSkill,

  // ── Link following (in-panel preview + capture) ──
  FETCH_URL_PREVIEW: handleFetchUrlPreview,
  CAPTURE_URL: handleCaptureUrl,
  GET_RESEARCH_STATUS: async () => {
    const job = await getResearchJob().catch(() => null) as any;
    // Running = an in-flight controller in THIS worker, OR an active job with
    // a fresh heartbeat (a run in another worker instance, or one still in
    // its startup window before the controller is registered).
    const fresh = !!job?.lastHeartbeatAt && Date.now() - job.lastHeartbeatAt < HEARTBEAT_STALE_MS;
    const running = !!job && (abortControllers.has(job.projectId) || (job.active && fresh));
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
// ─────────────────────────────────────────────
// Document Handlers — Local-First
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Link following — preview any URL inside the panel, capture if it's a keeper
// ─────────────────────────────────────────────
// Reading a captured page surfaces links worth chasing. Instead of bouncing
// the user out to a browser tab, fetch the target through the same pipeline
// research uses (Jina → local parse → quality-aware, PDFs via pdf.js) and
// show it in the side panel. Nothing is stored until the user hits Capture.

interface FetchedLinkPage { title: string; url: string; markdown: string; wordCount: number; isPdf: boolean }

async function fetchLinkPage(rawUrl: string): Promise<FetchedLinkPage> {
  const url = (rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http/https links can be previewed.');

  if (/\.pdf($|\?)/i.test(url) || await urlIsPdf(url).catch(() => false)) {
    const markdown = await pdfUrlToBody(url);
    const title = decodeURIComponent(url.split('/').pop() || url).replace(/\.pdf.*$/i, '') || url;
    return { title, url, markdown, wordCount: markdown.split(/\s+/).filter(Boolean).length, isPdf: true };
  }

  const scraped = await scrapeUrl(url);
  if (!scraped?.markdown) throw new Error('Could not extract readable content from that link (blocked or empty page).');
  return { title: scraped.title || url, url, markdown: scraped.markdown, wordCount: scraped.wordCount, isPdf: false };
}

async function handleFetchUrlPreview(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const page = await fetchLinkPage(request.url as string);
  return { title: page.title, url: page.url, markdown: page.markdown, wordCount: page.wordCount };
}

async function handleCaptureUrl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const page = await fetchLinkPage(request.url as string);
  const linkTarget = await resolveLinkTarget((request.projectId as string) || null);

  const now = new Date().toISOString();
  const fullMarkdown = buildFrontmatter({
    title: page.title,
    type: page.isPdf ? 'pdf' : 'web-capture',
    source: page.url,
    captured: now,
    wordCount: page.wordCount,
    tags: ['link-follow']
  }) + page.markdown;

  const docShortId = makeDocShortId(crypto.randomUUID?.() ?? `${Date.now()}`);
  const chunks = chunkDocument({ docShortId, content: fullMarkdown });

  const { id: docId, chunks: savedChunks, isDuplicate } = await saveDocument({
    title: page.title,
    url: page.url,
    content: fullMarkdown,
    capturedAt: now,
    favicon: '',
    wordCount: page.wordCount,
    syncedToDrive: false
  }, chunks);

  if (!isDuplicate && linkTarget) {
    await linkDocumentToProject(linkTarget, docId);
    await addChunksToVectorStore(linkTarget, savedChunks);
  } else if (isDuplicate && linkTarget) {
    // Already in the library from an earlier capture/run — just link it here
    await linkDocumentToProject(linkTarget, docId);
  }

  return { docId, title: page.title, chunkCount: chunks.length, linkedTo: linkTarget, isDuplicate: !!isDuplicate };
}

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

// Depth counter set while an interactive chat turn is assembling context.
// The embedder is one serialized WASM context (see offscreen-client mutex);
// during a deep-research run the queue fills with the run's batches. Marking a
// chat turn's embeds `priority` lets them jump ahead so the panel never freezes
// waiting minutes for the run to release the model. It's a depth (not a bool)
// because concurrent chat turns (two side panels) can overlap.
let interactiveDepth = 0;
const embedOpts = () => ({ priority: interactiveDepth > 0 });

const MAX_PAGE_CHARS = 30000;         // whole-page cutoff before per-question retrieval kicks in
const PAGE_RETRIEVAL_BUDGET = 22000;  // chars of the most-relevant sections on a long page

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
      const res: any = await sendToOffscreen({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts }, undefined, embedOpts());
      const embeddings: (number[] | null)[] = res?.ok && Array.isArray(res.embeddings) ? res.embeddings : [];
      chunks = raw.map((c, i) => ({ text: c.text, position: c.chunkIndex, embedding: embeddings[i] ?? null }));
      if (entry) entry.chunks = chunks;
    }

    const qRes: any = await sendToOffscreen({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: [question] }, undefined, embedOpts());
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
  // The sidepanel streams each PDF into OPFS and sends only its temp name +
  // byte size — the bytes never cross this message (no base64), which is what
  // let large books crash the renderer.
  const files = request.files as Array<{ name: string; opfsName: string; size: number }>;
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

        // A few hundred bytes is almost always a macOS Finder alias / Windows
        // shortcut picked instead of the real document — say so plainly.
        if (file.size > 0 && file.size < 16_384) {
          throw new Error(`only ${file.size} bytes — this looks like a shortcut/alias to the real file; open its location and pick the original`);
        }

        const body = await pdfOpfsToBody(file.opfsName, file.size, imageToText);
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
            const res: any = await sendToOffscreen({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: raw.map(c => c.text) });
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
  if (projectId) {
    abortControllers.get(projectId)?.abort();
    abortControllers.delete(projectId);
    // Stop is a FORCE-clear, not just an abort: a run wedged in a
    // non-abortable await (hung offscreen call, stalled stream) never
    // reaches its cleanup `finally`, leaving the active job record
    // blocking every future run. Clear it here unconditionally — if the
    // zombie promise ever settles, its own cleanup is a no-op.
    await markJobFinished().catch(() => {});
    await clearResearchJob().catch(() => {});
    // User pressed Stop — neutral cancel, not a failure or a success. (A live
    // run's own finally also broadcasts; the panel dedupes the pair.)
    chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_DONE', projectId, cancelled: true }).catch(() => {});
  }
  return {};
}

// ─────────────────────────────────────────────
// Chat Handler — Source-Grounded with Citations
// ─────────────────────────────────────────────

/**
 * Rewrite a context-dependent question ("how to use it?") into a standalone
 * one using the recent conversation + the page being discussed. The rewrite
 * drives RETRIEVAL ONLY — the model still receives the user's own words
 * (with full history), so the reply stays anchored to what they typed.
 */
async function resolveQuestionIntent(
  prompt: string,
  formattedHistory: Array<{ role: string; content: string }>,
  pageTitle: string | undefined,
  signal: AbortSignal
): Promise<string> {
  if (!needsIntentResolution(prompt, formattedHistory.length)) return prompt;
  try {
    const sys = `Rewrite the user's latest message as ONE standalone, search-friendly question. Resolve pronouns and references ("it", "this page", "the skill") using the conversation${pageTitle ? ' and the page they are viewing' : ''}. Keep the user's intent exactly — do not answer, broaden, or narrow it. Return ONLY the rewritten question.`;
    const user = `${pageTitle ? `Page being viewed: ${pageTitle}\n\n` : ''}Conversation:\n${formatHistoryForIntent(formattedHistory)}\n\nLatest message: ${prompt}`;
    const rewritten = (await chatWithCustom(sys, [], user, signal)).trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
    if (rewritten.length > 5 && rewritten.length < 300) {
      console.log(`[INTENT] "${prompt.slice(0, 60)}" → "${rewritten.slice(0, 80)}"`);
      return rewritten;
    }
  } catch (e) {
    console.warn('[INTENT] rewrite failed — using raw question', e);
  }
  return prompt;
}

/** Whether chat may escalate to a live web search when the workspace has no
 *  match. Default ON — absent/undefined counts as enabled; only an explicit
 *  false (user toggled it off in Config) disables it. */
async function isChatWebFallbackEnabled(): Promise<boolean> {
  try {
    const s = await chrome.storage.local.get(['chatWebFallback']);
    return s.chatWebFallback !== false;
  } catch {
    return true;
  }
}

/** Build the RAG system prompt + formatted history for a chat turn. */
/**
 * Intent router for an attached page (📄 ON): is this question actually ABOUT
 * the page, or an unrelated general question ("is it cold today?") that only
 * dead-ends if forced through the page path? Instant heuristics decide the
 * common cases (explicit page reference, or a keyword shared with the page);
 * only a genuinely ambiguous question costs one cheap classification call.
 * Fails OPEN to the page — the user did attach it.
 */
async function isQuestionAboutPage(q: string, page: PageContext, signal: AbortSignal): Promise<boolean> {
  // Weather / "near me" / local asks are about the world, not the open page —
  // route them out even if the page happens to contain a matching word.
  if (isLocationDependent(q)) return false;
  if (mentionsPageDeixis(q)) return true;
  if (overlapsPage(q, `${page.title} ${page.markdown.slice(0, 4000)}`)) return true;
  try {
    const sys =
      `You are an intent router. The user is viewing a web page titled "${page.title}". ` +
      `Decide whether their question is about THIS page (its subject, site, or content) or is an unrelated general question ` +
      `— weather, math, world facts, another website, personal chit-chat. Reply with exactly one word: PAGE or OTHER.`;
    const ans = await chatWithCustom(sys, [], q, signal);
    return !/\bOTHER\b/i.test(ans);
  } catch (e) {
    if (signal.aborted) throw e;
    return true; // provider hiccup — honor the attached page rather than drop it
  }
}

async function buildChatRequest(chatId: string, projectId: string, prompt: string, signal: AbortSignal, pageContext?: PageContext | null, onStatus?: (s: string) => void): Promise<{ systemPrompt: string; formattedHistory: Array<{ role: string; content: string }>; linkedPages: Array<{ title: string; url: string }>; grounded: boolean; place?: string }> {
  // Get all documents for this project
  const allDocs = await listDocuments(projectId);
  const enabledDocs = allDocs.filter(d => d.enabled !== false);
  const docIds = enabledDocs.map(d => d.id);
  const docTitles = new Map(enabledDocs.map(d => [d.id, d.title]));

  console.log(`[RAG] Project ${projectId}: ${enabledDocs.length} enabled docs, ${docIds.length} IDs`);

  // Persistent per-workspace instructions — prepended to EVERY prompt for this
  // workspace so the user never re-explains their stack/conventions/tone.
  const project = await getProject(projectId).catch(() => null);
  const rulesBlock = project?.rules?.trim()
    ? `--- WORKSPACE INSTRUCTIONS (always follow these for this workspace) ---\n${project.rules.trim()}\n--- END WORKSPACE INSTRUCTIONS ---\n\n`
    : '';

  // User locale context — an approximate place (explicit setting, else derived
  // from the system timezone) + timezone, so location/time-dependent questions
  // ("weather today", "near me") use the user's own region instead of the search
  // provider's IP geolocation. Coarse by design (city/region, never precise).
  const { userLocation, araTimezone } = await chrome.storage.local.get(['userLocation', 'araTimezone']);
  // Prefer the timezone captured by the sidepanel (a real document): MV3 service
  // workers can report Intl timeZone as "UTC", which would blank out the place
  // and make the model ask "what's your city?". Fall back to the worker's own.
  const swTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const tz = String(araTimezone || '').trim() || swTz;
  const place = String(userLocation || '').trim() || timezoneToPlace(tz);
  const localeBlock = place
    ? `--- USER CONTEXT (use for location/time-dependent questions; don't ask the user where they are) ---\n` +
      `Approximate location: ${place}${userLocation ? '' : ' (inferred from the system timezone — flag the assumption if relevant)'}.` +
      `${tz ? ` Timezone: ${tz}.` : ''}\n--- END USER CONTEXT ---\n\n`
    : '';

  // History first: intent resolution needs it (retrieved BEFORE the new user
  // message is saved, so it holds only prior turns).
  const history = await getChatHistory(chatId);
  const formattedHistory = history
    .filter((msg: any) => msg.role === 'user' || msg.role === 'assistant')
    .map((msg: any) => ({ role: msg.role, content: msg.text }));

  // Greetings / small talk must NOT run retrieval: it returns weak top-k
  // chunks that trip the strict "I cannot answer from the sources" refusal
  // (so "hi" got refused), and its query embedding would queue behind an
  // active research run at the offscreen embedder. Answer conversationally.
  // A greeting stays a greeting even with a web page open — an open tab
  // doesn't turn "hi" into a question, so don't gate this on pageContext.
  if (isChitchat(prompt)) {
    onStatus?.('Writing the answer…');
    const systemPrompt = rulesBlock +
      `You are Magpie, a warm, concise research assistant. The user sent a greeting or small talk — NOT a research question. ` +
      `Reply in ONE friendly sentence, then briefly invite them to ask about their captured sources or to run /research <topic>. ` +
      `Do NOT mention "sources" as though they asked a question, and do NOT say you can't answer.`;
    return { systemPrompt, formattedHistory, linkedPages: [], grounded: false };
  }

  // Follow-up questions get rewritten into standalone ones so retrieval,
  // page-section selection, and link scoring all see real signal.
  if (needsIntentResolution(prompt, formattedHistory.length)) onStatus?.('Understanding the question…');
  const effectiveQuery = await resolveQuestionIntent(prompt, formattedHistory, pageContext?.title, signal);

  // Intent router: an attached page only wins when the question is actually
  // about it. "is it cold today?" with a docs page open must NOT be forced
  // through the page path (→ "the page doesn't cover weather"); route it to the
  // normal workspace/web/general pipeline instead.
  const usePage = !!pageContext && await isQuestionAboutPage(effectiveQuery, pageContext, signal);
  if (pageContext && !usePage) console.log('[ROUTER] question is not about the open page — routing to workspace/web/general');
  if (!usePage) onStatus?.('Searching your sources…');

  // ── Multi-Query Adaptive RAG ──
  // 1. Initial search with the (intent-resolved) query
  // 2. If results are sparse, expand the query using the LLM into 2-3 variants
  // 3. Search each variant and merge results
  // Skip workspace retrieval when the page wins (usePage): searching the library
  // is then wasted work — and a wasted query embed on the hot path. When the
  // router sent an off-page question here (usePage false), we DO want retrieval.
  // Chit-chat already returned above.
  let relevantChunks: any[] = [];
  if (!usePage && docIds.length > 0) {
    relevantChunks = await searchSessionChunks(projectId, effectiveQuery, 40, docIds, embedOpts());
    console.log(`[RAG] Initial search for "${effectiveQuery.slice(0, 50)}..." returned ${relevantChunks.length} chunks`);

    // Adaptive multi-query: only expand when initial results are sparse
    if (relevantChunks.length < 5 && effectiveQuery.length > 10) {
      try {
        const expandedQueries = await expandQuery(effectiveQuery, signal);
        if (expandedQueries.length > 0) {
          console.log(`[RAG] Expanding query into ${expandedQueries.length} variants:`, expandedQueries);
          const existingIds = new Set(relevantChunks.map(c => c.id));

          for (const variant of expandedQueries) {
            const variantChunks = await searchSessionChunks(projectId, variant, 10, docIds, embedOpts());
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
        const titleChunks = await searchSessionChunks(projectId, doc.title, 5, docIds, embedOpts());
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

  // Answers render in a ~400px side panel; a 500-word tutorial for a
  // definition question is scroll punishment. Calibrate length to the ask.
  const RESPONSE_STYLE =
    `\nRESPONSE STYLE — write like an expert collaborator, not a chatbot:\n` +
    `• Lead with the answer or artifact. NO preamble, no "Certainly!/Great question!", no sycophancy, no closing summary.\n` +
    `• Sound human and plain-spoken: state facts directly ("it's 23°C in Helsinki, feels like 18°"), not stiff nominalizations ("is considered cold", "is described as pleasant"). No robotic hedging.\n` +
    `• Match length to the question: a definition gets 2-4 sentences, a how-to gets a compact step list. Don't pre-answer things not asked.\n` +
    `• Calibrate to the user's demonstrated expertise — use precise terms, don't over-explain standard basics.\n` +
    `• Prefer scannable structure — bold key terms, short lists, a comparison table — over dense paragraphs. Section headings only when several distinct things were asked.\n` +
    `• FAIL FAST: if the sources/page/inputs don't contain what's needed, or the request is ambiguous, SAY SO in one line — never guess persuasively to sound helpful.\n` +
    `• If a complex request is underspecified, state the key assumptions you're making in one line, then proceed.\n` +
    `• When fixing an error, name the ROOT CAUSE (why it failed) before the corrected version.`;

  // Web-search fallback sources (below) surface as clickable footer links.
  let webSources: Array<{ title: string; url: string }> = [];
  // True only on the workspace-grounded (citation) branch. The streaming layer
  // uses it to escalate to a web search if the model still refuses ("not found
  // in your sources") — the reliable safety net behind the score-based gate.
  let grounded = false;

  // Confidence gate: retrieval's keyword fallback almost always returns SOME
  // chunk, so "length > 0" is a poor "we have an answer" signal — a question
  // like "weather tomorrow" pulls borderline noise and then trips the citation
  // refusal instead of searching the web. Only ground on the workspace when the
  // best chunk is GENUINELY relevant (see isConfidentMatch); otherwise fall
  // through to the web-search / general-knowledge branch below.
  // 📄 ON (pageContext present) is an explicit "answer about THIS page" signal,
  // so the page wins outright — even a confident workspace match must not
  // hijack it. Without this gate, an imported library doc that happens to match
  // the keyword ("pricing") fires the citation branch and answers from the doc
  // (inventing tiers, citing [1..14]) while ignoring the page the user attached.
  // Location/live questions ("weather today") must not ground on the workspace —
  // a stray chunk that clears the confidence bar sends them to the citation
  // refusal ("cannot answer from sources") instead of a localized web answer.
  if (!usePage && !isLocationDependent(effectiveQuery) && isConfidentMatch(relevantChunks as Array<{ rerankScore?: number }>)) {
    grounded = true;
    // Build citation-anchored context (generous — favor fuller grounding over
    // "I couldn't find it" cutoffs; only fires for library-source questions).
    const context = buildCitationContext(relevantChunks, docTitles, 32000);

    // We add strict anti-hallucination prompts to the system prompt
    systemPrompt = CITATION_SYSTEM_PROMPT +
      `\nCRITICAL ANTI-HALLUCINATION RULE: If the answer cannot be found in the provided sources, you MUST say "I cannot answer this based on the provided sources." DO NOT rely on external knowledge.\n` +
      RESPONSE_STYLE +
      `\n--- SOURCES ---\n${context}\n--- END SOURCES ---`;
  } else if (usePage) {
    // The user attached the current page (📄 ON) AND the router judged the
    // question to be about it — answer from it (appended below), NOT from a live
    // web search and NOT
    // from library docs (workspace grounding is intentionally skipped above so a
    // keyword-matching imported doc can't override the page). Concretely:
    // a page-grounded question ("what is this?", "how much is their pricing?")
    // that also triggers a web search drags in unrelated hits (e.g. the pH-
    // indicator "litmus", a generic pricing guide) and pollutes the answer. If
    // the page genuinely doesn't cover it, the model says so and the user can
    // run /research explicitly. `grounded` stays false, so the streaming-layer
    // refusal→web net doesn't fire on these either.
    onStatus?.('Reading the page…');
    systemPrompt =
      `You are a helpful research assistant. Answer using the CURRENT PAGE the user is viewing (provided below); ` +
      `use your general knowledge only to fill small, obvious gaps. Do NOT invent citations. ` +
      `If the page doesn't cover the question, say so in one line rather than guessing or padding with unrelated facts.` +
      RESPONSE_STYLE;
  } else {
    // No workspace match and no open page. Before conceding to stale "general
    // knowledge", escalate to a quick live web search (+ any enabled search
    // MCPs) unless the user turned it off.
    let web: { context: string; sources: Array<{ title: string; url: string }> } = { context: '', sources: [] };
    if (await isChatWebFallbackEnabled()) {
      onStatus?.('Searching the web…');
      try {
        // Localize the query so "weather today" resolves to the user's region,
        // not the search provider's server IP.
        const webQuery = place && isLocationDependent(effectiveQuery) ? `${effectiveQuery} ${place}` : effectiveQuery;
        web = await gatherWebSnippets(webQuery, { signal, onStatus });
      } catch (e) {
        if (signal.aborted) throw e;
        console.warn('[chat web] fallback failed', e);
      }
    }

    if (web.context) {
      console.log(`[RAG] No workspace match — answered from ${web.sources.length} live web source(s)`);
      webSources = web.sources;
      systemPrompt =
        `You are a friendly, knowledgeable assistant. The excerpts below were pulled from a live web search just now — treat them as your facts. ` +
        `Answer the way a sharp, helpful friend would: lead with the direct answer in natural, plain language, then just enough detail — no more. ` +
        `Do NOT clutter the prose with [W#] tags or "per [W2]" — the sources are already shown as links below; reference one inline only if it genuinely adds clarity. ` +
        `Use only what the excerpts support; if they don't actually answer the question, say so plainly rather than padding.` +
        RESPONSE_STYLE +
        `\n--- WEB RESULTS ---\n${web.context}\n--- END WEB RESULTS ---`;
    } else {
      console.warn(`[RAG] No confident workspace match for project ${projectId} — falling back to general knowledge`);
      // General conversation fallback
      systemPrompt = `You are a helpful AI assistant. No relevant documents were found in the user's research workspace for this question. ` +
        `Begin your answer with this exact italic line: *No matching sources in this workspace — answering from general knowledge.* ` +
        `Then answer using your general knowledge. Do not fabricate citations.` +
        RESPONSE_STYLE;
    }
  }

  // Ephemeral page context: the tab the user is looking at right now.
  // Deliberately fenced off from library sources — it has no citation
  // anchors and is never persisted.
  const linkedPages: Array<{ title: string; url: string }> = [];
  // Web-fallback sources render as the same clickable footer as auto-followed
  // links (streamed as a final delta + saved with the message).
  if (webSources.length) linkedPages.push(...webSources);
  if (pageContext && usePage) {
    onStatus?.('Reading the page…');
    // Long pages switch to per-question retrieval (see selectPageMarkdown)
    const md = await selectPageMarkdown(pageContext, effectiveQuery);
    systemPrompt +=
      `\n\n--- CURRENT PAGE (the user is viewing this in their browser right now; it is NOT saved in their library) ---\n` +
      `Title: ${pageContext.title}\nURL: ${pageContext.url}\n\n${md}\n` +
      `--- END CURRENT PAGE ---\n` +
      `You may answer from the current page. Attribute such claims in plain text, e.g. "according to the page you're viewing". ` +
      `NEVER use [anchor] citations for current-page content — anchors are only for library sources.`;

    // Build/pipeline logs: guarantee the error/failure lines reach the model
    // even when the page is huge — retrieval selection can miss them.
    if (looksLikeBuildLog(pageContext.markdown)) {
      const hl = extractLogHighlights(pageContext.markdown);
      if (hl.highlights) {
        systemPrompt +=
          `\n\n--- LOG HIGHLIGHTS (error/warning lines auto-extracted from the page; NOT saved) ---\n` +
          `${hl.errorCount} error line(s), ${hl.warningCount} warning line(s) detected.\n\n${hl.highlights}\n` +
          `--- END LOG HIGHLIGHTS ---\n` +
          `When asked what failed or why, diagnose from these lines first, quoting the exact error text.`;
      }
    }

    // ── Selective enrichment ──
    // Load ONLY the repo files / page links relevant to this question, under a
    // shared budget + deadline — instead of dumping the whole tree and every
    // link. Strategy is user-toggleable (semantic | router | agentic).
    const strategy = await getPageContextStrategy();
    // The page is usually the repo itself. But "what's behind pricing?" on a
    // marketing page is really a CODE question — if that page links to its own
    // source repo, follow it one hop and answer from the code, not the copy.
    let repoRef = parseRepoUrl(pageContext.url);
    if (!repoRef && isImplementationQuestion(effectiveQuery)) {
      const linked = findRepoUrlInText(pageContext.markdown);
      const linkedRef = linked ? parseRepoUrl(linked) : null;
      if (linkedRef) {
        repoRef = linkedRef;
        onStatus?.('Found the source repo — reading the code…');
        console.log(`[REPO-LINK] implementation Q on a non-repo page → following ${linked}`);
      }
    }
    const tree = repoRef ? await getRepoTree(repoRef).catch(() => null) : null;

    // The full file tree is only useful for "where do things live" questions;
    // otherwise file CONTENTS come from the selector, not a path dump.
    if (tree && repoRef && isStructureQuestion(effectiveQuery)) {
      const { selected, truncated } = selectTreePaths(tree.paths, effectiveQuery);
      systemPrompt += formatTreeBlock(repoRef, selected, truncated);
      console.log(`[REPO-TREE] structure question — inlined ${selected.length}/${tree.paths.length} paths`);
    }

    const linkRefs: LinkRef[] = harvestReferences([pageContext.markdown], {
      seenUrls: new Set([pageContext.url]), isJunk: isJunkUrl, max: 150,
    }).filter(r => r.kind === 'web' && r.anchorText).map(r => ({ url: r.url, anchorText: r.anchorText }));

    // Semantic/router selection → budgeted fetch. Shared by the semantic path
    // and as the fallback when agentic can't tool-call.
    const semanticEnrich = async (): Promise<{ blocks: string[]; sources: Array<{ title: string; url: string }> }> => {
      const selection = await selectPageContext(
        'semantic', effectiveQuery, tree ? tree.paths : [], linkRefs, chatWithCustom, signal,
      ).catch(e => { console.warn('[CTX] selection failed:', e); return { files: [], links: [] } as Selection; });
      if (!selection.files.length && !selection.links.length) return { blocks: [], sources: [] };
      const items: EnrichItem[] = [
        ...(tree && repoRef ? selection.files.map(path => ({ kind: 'file' as const, path })) : []),
        ...selection.links.map(l => ({ kind: 'link' as const, url: l.url, title: l.title })),
      ];
      return fetchWithinBudget(items, async (item, sig) => {
        if (item.kind === 'file' && repoRef && tree) return fetchRepoFileBlock(repoRef, tree.branch, item.path);
        if (item.kind === 'link') return fetchLinkBlock(item.url, item.title, sig);
        return null;
      });
    };

    let enrich: { blocks: string[]; sources: Array<{ title: string; url: string }> };
    if (strategy === 'router') {
      // router selects, but reuses the same budgeted fetch as semantic
      onStatus?.('Choosing what to open…');
      const routed = await selectPageContext('router', effectiveQuery, tree ? tree.paths : [], linkRefs, chatWithCustom, signal)
        .catch(() => ({ files: [], links: [] } as Selection));
      const items: EnrichItem[] = [
        ...(tree && repoRef ? routed.files.map(path => ({ kind: 'file' as const, path })) : []),
        ...routed.links.map(l => ({ kind: 'link' as const, url: l.url, title: l.title })),
      ];
      enrich = items.length
        ? await fetchWithinBudget(items, async (item, sig) => {
            if (item.kind === 'file' && repoRef && tree) return fetchRepoFileBlock(repoRef, tree.branch, item.path);
            if (item.kind === 'link') return fetchLinkBlock(item.url, item.title, sig);
            return null;
          })
        : { blocks: [], sources: [] };
    } else if (strategy === 'agentic') {
      onStatus?.('Exploring the page…');
      enrich = await agenticGather(effectiveQuery, repoRef, tree, linkRefs, signal)
        .catch(async e => { console.warn('[CTX] agentic failed, falling back to semantic:', e); return semanticEnrich(); });
    } else {
      onStatus?.('Reading relevant files & links…');
      enrich = await semanticEnrich();
    }

    for (const b of enrich.blocks) systemPrompt += b;
    for (const s of enrich.sources) linkedPages.push(s);
    if (enrich.sources.length) console.log(`[CTX] followed ${enrich.sources.length} source(s): ${enrich.sources.map(s => s.url).join(', ')}`);

    // ── Forward-check the rest of THIS site ──
    // On a docs/site page, "where can I find X?" about a topic the current page
    // doesn't cover shouldn't dead-end at "not on this page". If nothing on the
    // page satisfied it, search the SAME DOMAIN only (e.g. learn.microsoft.com) —
    // "check the rest of the documentation" without pulling the open web. Skipped
    // for page-summary asks (the answer is the page) and when web search is off.
    const host = (() => { try { return new URL(pageContext.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const isLocalHost = !host || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(host) || host.endsWith('.local');
    if (
      !enrich.sources.length && !repoRef && host && !isLocalHost &&
      questionKeywords(effectiveQuery).length && !isPageMetaQuestion(effectiveQuery) &&
      await isChatWebFallbackEnabled()
    ) {
      onStatus?.(`Checking the rest of ${host}…`);
      try {
        const site = await gatherWebSnippets(effectiveQuery, { signal, restrictToHost: host, deadlineMs: 8000 });
        if (site.context) {
          console.log(`[FORWARD-CHECK] ${host}: ${site.sources.length} same-site result(s)`);
          systemPrompt +=
            `\n\n--- ELSEWHERE ON ${host} (same site the user is reading; found via a site-scoped search just now, NOT saved) ---\n` +
            `${site.context}\n--- END ---\n` +
            `The current page didn't cover this. You MAY answer from these same-site results and should point the user to the relevant page. Attribute claims in plain text to their [W#] source; do not invent anchors.`;
          for (const s of site.sources) linkedPages.push(s);
        }
      } catch (e) {
        if (signal.aborted) throw e;
        console.warn('[FORWARD-CHECK] failed', e);
      }
    }
  }

  onStatus?.('Writing the answer…');
  return { systemPrompt: rulesBlock + localeBlock + systemPrompt, formattedHistory, linkedPages, grounded, place };
}

/**
 * Clickable trail of the links the expansion step actually followed —
 * appended to the reply so the user can open them (in-panel preview) even
 * when the model doesn't cite them inline. Part of the saved message, so it
 * survives reloads.
 */
function linkedPagesFooter(pages: Array<{ title: string; url: string }>): string {
  if (pages.length === 0) return '';
  // Concise provenance, not a reading list: dedupe by URL, cap at 3, and prefer
  // a short label. Web-search titles are long and noisy ("Helsinki, Uusimaa,
  // Finland Hourly Weather | AccuWeather") — collapse those to the site name;
  // short anchor titles from followed on-page links (e.g. "Pricing") stay as-is.
  const seen = new Set<string>();
  const items: string[] = [];
  for (const p of pages) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    let host = '';
    try { host = new URL(p.url).hostname.replace(/^www\./, ''); } catch { /* keep title */ }
    const t = (p.title || '').trim();
    const label = (t && t.length <= 40 ? t : (host || t || p.url)).replace(/[\[\]]/g, '');
    items.push(`[${label}](${p.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
    if (items.length >= 3) break;
  }
  return `\n\n---\n*Sources:* ${items.join(' · ')}`;
}

// ─────────────────────────────────────────────
// Repository file-tree context — GitHub, GitLab, Azure DevOps, Bitbucket
// ─────────────────────────────────────────────
// A repo page scrape captures the README, not the tree. When the discussed
// page is a repository on a known code host, pull its file listing from the
// host's public API (keyless — private repos silently skip) and inline it
// ephemerally next to the page context.

interface RepoTree { paths: string[]; branch: string }
const repoTreeCache = new Map<string, { tree: RepoTree; ts: number }>();
const REPO_TREE_TTL_MS = 10 * 60 * 1000;
const REPO_TREE_MAX_ENTRIES = 8_000; // give up on monorepos — a truncated random slice misleads

async function fetchGitHubTree(ref: RepoRef): Promise<RepoTree | null> {
  let branch = ref.branch;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (!branch) {
    const repoRes = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers });
    if (!repoRes.ok) return null;
    branch = (await repoRes.json()).default_branch as string;
  }
  const treeRes = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch!)}?recursive=1`,
    { headers }
  );
  if (!treeRes.ok) return null;
  const tree = await treeRes.json();
  const paths = (tree.tree || []).map((t: any) => t.type === 'tree' ? `${t.path}/` : t.path).filter(Boolean);
  return { paths, branch: branch! };
}

async function fetchGitLabTree(ref: RepoRef): Promise<RepoTree | null> {
  const projectId = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  let branch = ref.branch;
  if (!branch) {
    const projRes = await fetch(`https://gitlab.com/api/v4/projects/${projectId}`, { headers: { 'Accept': 'application/json' } });
    if (!projRes.ok) return null;
    branch = (await projRes.json()).default_branch as string;
    if (!branch) return null;
  }
  const paths: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(
      `https://gitlab.com/api/v4/projects/${projectId}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return page === 1 ? null : { paths, branch };
    const items: any[] = await res.json();
    paths.push(...items.map(t => t.type === 'tree' ? `${t.path}/` : t.path));
    if (items.length < 100 || paths.length > REPO_TREE_MAX_ENTRIES) break;
  }
  return { paths, branch };
}

async function fetchAzureTree(ref: RepoRef): Promise<RepoTree | null> {
  // Works for PUBLIC Azure DevOps projects; private ones answer with a
  // sign-in redirect / non-JSON, which the parse guard turns into a skip.
  const res = await fetch(
    `https://dev.azure.com/${ref.owner}/${encodeURIComponent(ref.project!)}/_apis/git/repositories/${encodeURIComponent(ref.repo)}/items?recursionLevel=Full&api-version=7.1-preview.1` +
    (ref.branch ? `&versionDescriptor.version=${encodeURIComponent(ref.branch)}&versionDescriptor.versionType=branch` : ''),
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
  const data = await res.json();
  const paths = (data.value || [])
    .map((t: any) => {
      const p = String(t.path || '').replace(/^\//, '');
      return p ? (t.isFolder ? `${p}/` : p) : '';
    })
    .filter(Boolean);
  return { paths, branch: ref.branch ?? '' }; // '' = server default on raw fetch
}

async function fetchBitbucketTree(ref: RepoRef): Promise<RepoTree | null> {
  let branch = ref.branch;
  if (!branch) {
    const repoRes = await fetch(`https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}`);
    if (!repoRes.ok) return null;
    branch = (await repoRes.json()).mainbranch?.name as string;
    if (!branch) return null;
  }
  const paths: string[] = [];
  let next: string | null =
    `https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}/src/${encodeURIComponent(branch)}/` +
    `?max_depth=8&pagelen=100&fields=values.path,values.type,next`;
  for (let page = 0; next && page < 20; page++) {
    const res: Response = await fetch(next);
    if (!res.ok) return paths.length > 0 ? { paths, branch } : null;
    const data: any = await res.json();
    paths.push(...(data.values || []).map((v: any) => v.type === 'commit_directory' ? `${v.path}/` : v.path));
    next = data.next || null;
    if (paths.length > REPO_TREE_MAX_ENTRIES) break;
  }
  return { paths, branch };
}

const TREE_FETCHERS: Record<RepoRef['provider'], (ref: RepoRef) => Promise<RepoTree | null>> = {
  github: fetchGitHubTree,
  gitlab: fetchGitLabTree,
  azure: fetchAzureTree,
  bitbucket: fetchBitbucketTree
};

async function getRepoTree(ref: RepoRef): Promise<RepoTree | null> {
  const cacheKey = `${ref.provider}:${ref.label}@${ref.branch ?? ''}`;
  const entry = repoTreeCache.get(cacheKey);
  if (entry && Date.now() - entry.ts < REPO_TREE_TTL_MS) return entry.tree;
  const tree = await TREE_FETCHERS[ref.provider](ref);
  if (!tree || tree.paths.length === 0 || tree.paths.length > REPO_TREE_MAX_ENTRIES) return null;
  repoTreeCache.set(cacheKey, { tree, ts: Date.now() });
  return tree;
}

// ── Repo file contents — fetch the raw text of a selected file ──

const repoFileCache = new Map<string, { text: string; ts: number }>();
const REPO_FILE_MAX_CHARS = 14_000;       // per file

async function fetchRepoFileRaw(ref: RepoRef, branch: string, path: string): Promise<string | null> {
  const encPath = path.split('/').map(encodeURIComponent).join('/');
  let url: string;
  switch (ref.provider) {
    case 'github':
      url = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${encPath}`;
      break;
    case 'gitlab':
      url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`;
      break;
    case 'azure':
      url = `https://dev.azure.com/${ref.owner}/${encodeURIComponent(ref.project!)}/_apis/git/repositories/${encodeURIComponent(ref.repo)}/items?path=/${encPath}&api-version=7.1-preview.1` +
        (branch ? `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch` : '');
      break;
    case 'bitbucket':
      url = `https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}/src/${encodeURIComponent(branch)}/${encPath}`;
      break;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return res.text();
}

// ─────────────────────────────────────────────
// Ephemeral link expansion — second-hop context, never saved
// ─────────────────────────────────────────────
// When the user chats WITH a page, the answer often lives one click deeper.
// Score the page's outgoing links against the question (offscreen
// cross-encoder on anchor text), fetch the best 1-2 ephemerally, and inline
// them next to the page context. Same contract as page context: in-memory
// TTL cache only, nothing touches IndexedDB or the vector store, and the
// model must not fake [anchor] citations for it.

const LINKED_PAGE_BUDGET = 8_000;       // chars per followed link in the prompt

// ─────────────────────────────────────────────
// Selective page-context enrichment (files · links) — strategy-driven
// ─────────────────────────────────────────────
// Instead of dumping the repo tree + every link, load only what THIS question
// needs. Strategies are user-toggleable; all share the fetch plumbing below.

type PageCtxStrategy = 'semantic' | 'router' | 'agentic';
async function getPageContextStrategy(): Promise<PageCtxStrategy> {
  try {
    const s = await chrome.storage.local.get(['pageContextStrategy']);
    return s.pageContextStrategy === 'router' || s.pageContextStrategy === 'agentic' ? s.pageContextStrategy : 'semantic';
  } catch { return 'semantic'; }
}

/** Offscreen cross-encoder as a plain RerankFn for the selector. */
const offscreenRerank: RerankFn = async (query, passages) => {
  try {
    const res: any = await sendToOffscreen({ action: 'OFFSCREEN_RERANK', query, passages }, undefined, embedOpts());
    return res?.ok && Array.isArray(res.scores) ? res.scores : null;
  } catch { return null; }
};

/**
 * ROUTER strategy: one small LLM call picks which files/links to open. Shows a
 * bounded catalog (relevant paths via selectTreePaths + link labels); the reply
 * is validated against that catalog so a hallucinated path never becomes a fetch.
 * Returns null on any failure so the caller falls back to semantic selection.
 */
async function selectRouter(
  question: string, filePaths: string[], links: LinkRef[],
  llmChat: (sys: string, hist: any[], user: string, signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<Selection | null> {
  const catalogFiles = filePaths.length
    ? selectTreePaths(filePaths.filter(p => !p.endsWith('/')), question, 6_000).selected
    : [];
  const catalogLinks = links.slice(0, 60);
  if (catalogFiles.length === 0 && catalogLinks.length === 0) return { files: [], links: [] };

  const sys =
    `You choose which extra sources to open to answer a question about a web page. ` +
    `Pick ONLY what's needed — at most 3 files and 2 links, fewer is better, none if the page/your knowledge already suffices. ` +
    `Reply with ONLY a JSON object: {"files": [<exact paths>], "links": [<exact urls>], "web": <true|false>}. No prose.`;
  const user =
    `Question: ${question}\n\n` +
    (catalogFiles.length ? `Repository files:\n${catalogFiles.join('\n')}\n\n` : '') +
    (catalogLinks.length ? `Page links (title — url):\n${catalogLinks.map(l => `${l.anchorText || l.url} — ${l.url}`).join('\n')}\n` : '');
  try {
    const raw = await llmChat(sys, [], user, signal);
    return parseRouterSelection(raw, catalogFiles, catalogLinks);
  } catch (e) {
    console.warn('[CTX] router LLM selection failed:', e);
    return null;
  }
}

/** Pick the files/links to load for a page turn, per the active strategy.
 *  'agentic' is driven from the streaming layer; reaching here under it (the
 *  non-stream path) falls back to semantic selection. */
async function selectPageContext(
  strategy: PageCtxStrategy, question: string, filePaths: string[], links: LinkRef[],
  llmChat: (sys: string, hist: any[], user: string, signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<Selection> {
  const files = filePaths.filter(p => !p.endsWith('/'));
  if (strategy === 'router') {
    const routed = await selectRouter(question, filePaths, links, llmChat, signal);
    if (routed) return routed;   // else fall through to semantic
  }
  return selectSemantic(question, files, links, offscreenRerank);
}

type EnrichItem = { kind: 'file'; path: string } | { kind: 'link'; url: string; title: string };

/** Fetch + format one repo file for the prompt (cached, per-file capped). */
async function fetchRepoFileBlock(ref: RepoRef, branch: string, path: string): Promise<{ block: string; chars: number } | null> {
  const cacheKey = `${ref.provider}:${ref.label}@${branch}:${path}`;
  let entry = repoFileCache.get(cacheKey);
  if (!entry || Date.now() - entry.ts > REPO_TREE_TTL_MS) {
    const text = await fetchRepoFileRaw(ref, branch, path).catch(() => null);
    if (!text) return null;
    entry = { text, ts: Date.now() };
    repoFileCache.set(cacheKey, entry);
  }
  const truncated = entry.text.length > REPO_FILE_MAX_CHARS;
  const body = truncated ? entry.text.slice(0, REPO_FILE_MAX_CHARS) : entry.text;
  const ext = path.split('.').pop() || '';
  const block =
    `\n\n--- REPOSITORY FILE: ${path} (${ref.label}; fetched from the ${ref.provider} API; NOT saved) ---\n` +
    '```' + ext + '\n' + body + (truncated ? '\n… (file truncated)' : '') + '\n```\n--- END FILE ---';
  return { block, chars: body.length };
}

/** Fetch + format one followed link for the prompt (cached, budget-sliced). */
async function fetchLinkBlock(url: string, title: string, signal: AbortSignal): Promise<{ block: string; chars: number; source: { title: string; url: string } } | null> {
  let md: string, t: string;
  const cached = pageContextCache.get(url);
  if (cached && Date.now() - cached.ts < PAGE_CONTEXT_TTL_MS) {
    md = cached.ctx.markdown; t = cached.ctx.title;
  } else {
    const scraped = await scrapeUrl(url, signal).catch(() => null);
    if (!scraped?.markdown) return null;
    md = scraped.markdown; t = scraped.title || title;
    pageContextCache.set(url, { ctx: { title: t, url, markdown: md }, ts: Date.now() });
  }
  const body = md.slice(0, LINKED_PAGE_BUDGET);
  const block =
    `\n\n--- LINKED PAGE (followed from the current page because it looked relevant; NOT saved) ---\n` +
    `Title: ${t}\nURL: ${url}\n\n${body}\n--- END LINKED PAGE ---\n` +
    `Attribute claims from it in plain text — you may link it inline as [${t}](${url}). No [anchor] citations.`;
  return { block, chars: body.length, source: { title: t, url } };
}

// ── AGENTIC strategy: let the model open files/links/web on demand ──
const MAX_TOOL_ROUNDS = 3;

/**
 * Bounded tool loop: the model decides which files/links to read (and whether to
 * search the web) to answer, calling tools until it has enough or the round /
 * budget cap is hit. Returns the gathered prompt blocks + sources; the normal
 * streaming answer then runs with them appended (so citations/footer/streaming
 * all stay intact). Throws only on a provider that can't tool-call — the caller
 * then falls back to semantic selection.
 */
async function agenticGather(
  question: string, repoRef: RepoRef | null, tree: RepoTree | null, linkRefs: LinkRef[], signal: AbortSignal,
): Promise<{ blocks: string[]; sources: Array<{ title: string; url: string }> }> {
  const tools: ToolDef[] = [];
  const catalogFiles = tree && repoRef ? selectTreePaths(tree.paths.filter(p => !p.endsWith('/')), question, 6_000).selected : [];
  if (catalogFiles.length) {
    tools.push({ type: 'function', function: { name: 'read_file', description: 'Read the raw contents of one repository file by its exact path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } });
  }
  if (linkRefs.length) {
    tools.push({ type: 'function', function: { name: 'read_link', description: 'Fetch the readable content of one link found on the current page, by its exact URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } });
  }
  const webAllowed = await isChatWebFallbackEnabled();
  if (webAllowed) {
    tools.push({ type: 'function', function: { name: 'search_web', description: 'Run a live web search when the page and repo cannot answer.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } });
  }
  if (tools.length === 0) return { blocks: [], sources: [] };

  const catalogLinks = linkRefs.slice(0, 60);
  const sys =
    `You gather just enough context to answer a question about the web page the user is viewing. ` +
    `Open only the FEW files/links that matter (≤4 total); search the web only if the page/repo can't answer. ` +
    `Stop calling tools as soon as you have enough — do not over-fetch.\n` +
    (catalogFiles.length ? `\nRepository files you may read:\n${catalogFiles.join('\n')}\n` : '') +
    (catalogLinks.length ? `\nPage links you may read:\n${catalogLinks.map(l => `${l.anchorText || l.url} — ${l.url}`).join('\n')}\n` : '');
  const messages: any[] = [{ role: 'system', content: sys }, { role: 'user', content: question }];

  const blocks: string[] = [];
  const sources: Array<{ title: string; url: string }> = [];
  let used = 0;
  const validPaths = new Set(catalogFiles);
  const linkByUrl = new Map(linkRefs.map(l => [l.url, l]));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await chatWithTools(messages, tools, signal);   // may throw → caller falls back
    if (resp.toolCalls.length === 0) break;
    messages.push(resp.assistantMessage);
    for (const call of resp.toolCalls) {
      let result = 'error';
      try {
        if (call.name === 'read_file' && repoRef && tree) {
          const path = String(call.args?.path || '');
          if (!validPaths.has(path)) result = 'path not in this repo';
          else {
            const b = await fetchRepoFileBlock(repoRef, tree.branch, path);
            if (b && used + b.chars <= TOTAL_CTX_BUDGET) { blocks.push(b.block); used += b.chars; result = `read ${path}`; }
            else result = b ? 'context budget full' : 'file unavailable';
          }
        } else if (call.name === 'read_link') {
          const url = String(call.args?.url || '');
          const known = linkByUrl.get(url);
          if (!known) result = 'link not on the page';
          else {
            const b = await fetchLinkBlock(url, known.anchorText || url, signal);
            if (b && used + b.chars <= TOTAL_CTX_BUDGET) { blocks.push(b.block); sources.push(b.source); used += b.chars; result = `read ${url}`; }
            else result = b ? 'context budget full' : 'unreadable';
          }
        } else if (call.name === 'search_web' && webAllowed) {
          const web = await gatherWebSnippets(String(call.args?.query || question), { signal });
          if (web.context && used + web.context.length <= TOTAL_CTX_BUDGET) {
            blocks.push(`\n\n--- WEB RESULTS ---\n${web.context}\n--- END WEB RESULTS ---`);
            sources.push(...web.sources); used += web.context.length; result = 'web results added';
          } else result = 'no useful web results';
        } else {
          result = 'unknown tool';
        }
      } catch (e) {
        if (signal.aborted) throw e;
        result = 'error fetching';
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    if (used >= TOTAL_CTX_BUDGET) break;
  }
  console.log(`[CTX/agentic] gathered ${blocks.length} block(s), ${sources.length} source(s)`);
  return { blocks, sources };
}

/**
 * Use the LLM to expand a user query into 2-3 search reformulations.
 * This catches synonym mismatches, misspellings, and conceptual gaps.
 */
async function expandQuery(userQuery: string, signal: AbortSignal): Promise<string[]> {
  const { apiKey, endpoint, model } = await getProviderSettings();
  if (!endpoint || !model) return [];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal,
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

  // Mark this an interactive turn so its embeds jump ahead of any research run.
  interactiveDepth++;
  try {
    const pageCtx = request.includePageContext ? await getPageContext().catch(() => null) : null;
    const { systemPrompt, formattedHistory, linkedPages } = await buildChatRequest(chatId, projectId, prompt, signal, pageCtx);

    // Persist the user message immediately so it survives errors/reloads
    await saveChatMessage({
      chatId,
      role: 'user',
      text: prompt,
      timestamp: new Date().toISOString(),
      provider: 'custom'
    });

    const reply = await chatWithCustom(systemPrompt, formattedHistory, prompt, signal)
      + linkedPagesFooter(linkedPages);

    await saveChatMessage({
      chatId,
      role: 'assistant',
      text: reply,
      timestamp: new Date().toISOString(),
      provider: 'custom'
    });

    return { reply };
  } finally {
    interactiveDepth = Math.max(0, interactiveDepth - 1);
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

    // Each request gets its own controller + accumulator
    controller = new AbortController();
    abortControllers.set(chatId, controller);
    const localController = controller;
    let full = '';

    // Keep the MV3 worker alive for the whole turn. Context assembly (intent
    // call, retrieval, link scrapes) and a slow provider's time-to-first-token
    // are silent gaps; a >30s gap with no chrome API activity evicts the worker
    // mid-answer → dropped port → lost/incomplete response. A periodic API call
    // resets the idle timer. (Same guard the research run uses.)
    const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo?.().catch(() => {}); }, 20000);

    // Mark this an interactive turn so its embeds (page context, retrieval,
    // rerank) jump ahead of a concurrent research run instead of freezing.
    interactiveDepth++;
    try {
      const pageCtx = req.includePageContext ? await getPageContext().catch(() => null) : null;
      let { systemPrompt, formattedHistory, linkedPages, grounded, place } = await buildChatRequest(
        chatId, projectId, prompt, localController.signal, pageCtx,
        (text) => safePost({ type: 'STATUS', text })
      );

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

      // Tell OTHER sidepanel instances a question is in flight for this chat, so
      // they show the same "thinking" spinner (the live token stream stays on the
      // initiating port; they reload the answer on CHAT_STATE:false).
      chrome.runtime.sendMessage({ action: 'CHAT_STATE', chatId, projectId, generating: true }).catch(() => {});

      await chatWithCustomStream(systemPrompt, formattedHistory, prompt, localController.signal, (delta) => {
        full += delta;
        safePost({ type: 'DELTA', text: delta });
      });

      // RELIABLE NET: the score gate can still let a workspace-grounded turn
      // reach a refusal (reranker unavailable, or a keyword chunk that squeaks
      // over the bar). If the model itself says it can't answer from the
      // sources, escalate to a live web search and REPLACE the refusal — the
      // model's own judgment is the ground truth the scores only approximate.
      if (grounded && !systemPromptOverride && isRefusalAnswer(full) && await isChatWebFallbackEnabled()) {
        safePost({ type: 'STATUS', text: 'Not in your workspace — searching the web…' });
        // Localize the query (same as the main web branch) so "weather today"
        // resolves to the user's region, not the search provider's server IP.
        const netQuery = place && isLocationDependent(prompt) ? `${prompt} ${place}` : prompt;
        const web = await gatherWebSnippets(netQuery, {
          signal: localController.signal,
          onStatus: (text) => safePost({ type: 'STATUS', text }),
        }).catch(() => ({ context: '', sources: [] as Array<{ title: string; url: string }> }));

        if (web.context) {
          safePost({ type: 'RESET' });   // clear the refusal from the panel
          full = '';
          const webSys =
            (place ? `The user is in ${place}; answer for that location and do NOT ask them which city. ` : '') +
            `You are a friendly, knowledgeable assistant. The excerpts below are from a live web search run just now — treat them as your facts. ` +
            `Answer like a sharp, helpful friend: lead with the direct answer in natural, plain language, then just enough detail. ` +
            `Don't clutter the prose with [W#] tags — the sources are shown as links below. Use only what the excerpts support; if they don't answer it, say so plainly.` +
            `\n--- WEB RESULTS ---\n${web.context}\n--- END WEB RESULTS ---`;
          await chatWithCustomStream(webSys, [], prompt, localController.signal, (delta) => {
            full += delta;
            safePost({ type: 'DELTA', text: delta });
          });
          linkedPages = web.sources; // footer below now points at the web sources
        }
      }

      // Deterministic clickable trail of auto-followed links — streamed as a
      // final delta so it renders live AND lands in the saved message.
      const footer = linkedPagesFooter(linkedPages);
      if (footer && full.trim()) {
        full += footer;
        safePost({ type: 'DELTA', text: footer });
      }

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
      const aborted = localController.signal.aborted;
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
      interactiveDepth = Math.max(0, interactiveDepth - 1);
      clearInterval(keepAlive);
      if (abortControllers.get(chatId) === localController) abortControllers.delete(chatId);
      // Clear the spinner on other instances and let them pull the saved answer.
      chrome.runtime.sendMessage({ action: 'CHAT_STATE', chatId, projectId, generating: false }).catch(() => {});
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
    `Today's date is ${new Date().toISOString().slice(0, 10)}. You rewrite a user's research request into ONE self-contained, web-searchable research topic. The request may reference the conversation or the user's workspace documents ("these", "this model", "the above"). Resolve those references using the provided context. Return ONLY the rewritten topic as a single sentence — no quotes, no explanation. If the request is already self-contained, return it unchanged.`,
    `Workspace documents: ${titles || '(none)'}\n\nRecent conversation:\n${recent || '(none)'}\n\nResearch request: ${topic}`
  );

  const cleaned = res.trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
  return (cleaned.length > 5 && cleaned.length < 300) ? cleaned : topic;
}

/**
 * Preview handler: resolves the topic + generates sub-questions so the
 * sidepanel can show a confirmation modal before research begins.
 */
async function handlePreviewDeepResearch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { projectId, topic, chatId } = request;
  if (!projectId || !topic) throw new Error('projectId and topic are required');

  const chatFn = (s: string, u: string) => chatWithCustom(s, [], u);

  // Resolve conversational references into a standalone topic
  let effectiveTopic = topic as string;
  try {
    effectiveTopic = await resolveResearchTopic(topic as string, chatId as string | undefined, projectId as string, chatFn);
  } catch {
    // fallback to raw topic
  }

  // Generate research directives for user review
  const subQuestions = await generateSubQuestions(effectiveTopic, chatFn).catch(() => [] as string[]);

  // Shape of the run, so the plan card can show the pipeline + a time
  // expectation: quick = one gather pass; deep = N staged rounds by depth.
  const limits = await getResearchLimits();
  const mode = (request.mode as string) === 'deep' ? 'deep' : 'quick';
  const stages = mode === 'deep' ? limits.rounds : 1;
  const estMinutes = mode === 'deep' ? Math.max(8, stages * 6) : 4;

  return { effectiveTopic, subQuestions, stages, estMinutes };
}

/**
 * Refine a draft research plan from conversational feedback. The user sees
 * the plan card in chat and types adjustments ("drop question 3", "focus on
 * EU regulation instead") — one LLM call returns the revised plan.
 */
async function handleRefineResearchPlan(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const effectiveTopic = request.effectiveTopic as string;
  const subQuestions = (request.subQuestions as string[]) || [];
  const feedback = request.feedback as string;
  if (!effectiveTopic || !feedback) throw new Error('effectiveTopic and feedback are required');

  const sys = `You are revising a research plan based on user feedback. Apply the feedback faithfully: reword/add/remove sub-questions, narrow or broaden the topic — whatever the user asked. Keep 3-7 sub-questions.
Return STRICT JSON only: {"topic": "<revised research topic, one sentence>", "subQuestions": ["...", ...]}`;
  const user = `CURRENT PLAN
Topic: ${effectiveTopic}
Sub-questions:
${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') || '(none)'}

USER FEEDBACK: ${feedback}`;

  const res = await chatWithCustom(sys, [], user);
  const start = res.indexOf('{');
  const end = res.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Could not parse revised plan');
  const json = JSON.parse(res.slice(start, end + 1));
  const revisedTopic = typeof json.topic === 'string' && json.topic.length > 3 ? json.topic : effectiveTopic;
  const revisedQuestions = Array.isArray(json.subQuestions)
    ? json.subQuestions.filter((q: unknown) => typeof q === 'string' && (q as string).length > 3).slice(0, 7)
    : subQuestions;
  return { effectiveTopic: revisedTopic, subQuestions: revisedQuestions };
}

// ─────────────────────────────────────────────
// /create-skill — distill workspace research into a reusable slash command
// ─────────────────────────────────────────────

const SKILL_CMD_SHAPE = /^\/[a-z0-9-]{2,24}$/;

async function handleCreateSkill(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string;
  const instruction = (request.instruction as string) || '';
  if (!projectId) throw new Error('projectId is required');

  // Context: workspace doc titles + the most relevant chunks for the
  // instruction (or a broad sample when no focus is given).
  const allDocs = await listDocuments(projectId);
  const enabledDocs = allDocs.filter(d => d.enabled !== false);
  if (enabledDocs.length === 0) {
    throw new Error('This workspace has no sources yet — capture pages or run /research first, then create a skill from the findings.');
  }
  const docIds = enabledDocs.map(d => d.id);
  const query = instruction || enabledDocs.slice(0, 5).map(d => d.title).join('; ');
  const chunks = await searchSessionChunks(projectId, query, 20, docIds).catch(() => [] as any[]);
  const evidence = chunks.map((c: any) => c.text).join('\n\n').slice(0, 12_000);
  const titles = enabledDocs.slice(0, 15).map(d => `- ${d.title}`).join('\n');

  const sys = `You are building a reusable "skill" — a custom slash command for a research assistant. A skill is a system prompt that captures domain knowledge distilled from the user's research, so future chats can apply that knowledge instantly.

Given the workspace research below, produce STRICT JSON:
{
  "cmd": "/<short-kebab-name>",
  "desc": "<one-line description of what the skill does>",
  "systemPrompt": "<the skill itself — see requirements>"
}

systemPrompt requirements:
- Start with a role/persona sentence grounded in this domain.
- Include a "Key knowledge:" section with the most important facts, terminology, numbers, and findings from the research (bullet list, specific — not generic).
- Include a "When answering:" section with 3-5 behavioral rules (structure, what to check, common pitfalls in this domain).
- 150-400 words. Self-contained: it will run in future chats WITHOUT the research documents attached.
- cmd: 2-24 chars, lowercase letters/digits/hyphens only, memorable.

Return ONLY the JSON.`;

  const user = `${instruction ? `USER'S SKILL REQUEST: ${instruction}\n\n` : ''}WORKSPACE DOCUMENTS:\n${titles}\n\nRESEARCH EXCERPTS:\n${evidence || '(no indexed excerpts — use document titles)'}`;

  const res = await chatWithCustom(sys, [], user);
  const start = res.indexOf('{');
  const end = res.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Skill generation failed — the model returned no JSON');
  const json = JSON.parse(res.slice(start, end + 1));

  let cmd = String(json.cmd || '').trim().toLowerCase();
  if (!cmd.startsWith('/')) cmd = '/' + cmd;
  cmd = cmd.replace(/[^a-z0-9/-]/g, '-').replace(/-{2,}/g, '-');
  const desc = String(json.desc || '').trim().slice(0, 100) || 'Custom skill';
  const systemPrompt = String(json.systemPrompt || '').trim();
  if (!SKILL_CMD_SHAPE.test(cmd) || systemPrompt.length < 50) {
    throw new Error('Skill generation failed — malformed command or empty prompt');
  }

  // Persist into customSkills (same store Settings manages) with collision-safe naming
  const s = await chrome.storage.local.get(['customSkills']);
  const skills: Array<{ cmd: string; desc: string; systemPrompt: string }> =
    Array.isArray(s.customSkills) ? s.customSkills : [];
  const taken = new Set(skills.map(sk => sk.cmd));
  const BUILTINS = new Set(['/page', '/research', '/deepresearch', '/analyze', '/recall', '/compare', '/timeline', '/challenge', '/connect', '/extract', '/brief', '/clear', '/help', '/create-skill']);
  let finalCmd = cmd;
  let n = 2;
  while (taken.has(finalCmd) || BUILTINS.has(finalCmd)) finalCmd = `${cmd}-${n++}`;
  skills.push({ cmd: finalCmd, desc, systemPrompt });
  await chrome.storage.local.set({ customSkills: skills });

  // Also save the skill as a browsable document (portable, exportable) —
  // enabled:false so the prompt text never enters chat retrieval.
  const skillBody = `${desc}\n\n## Command\n\n\`${finalCmd} <your question>\`\n\n## System Prompt\n\n${systemPrompt}\n`;
  const content = buildFrontmatter({
    title: `Skill: ${finalCmd}`,
    type: 'skill',
    wordCount: skillBody.split(/\s+/).filter(Boolean).length,
    tags: ['skill']
  }) + skillBody;
  try {
    const { id } = await saveDocument({
      title: `Skill: ${finalCmd}`,
      url: '',
      content,
      capturedAt: new Date().toISOString(),
      favicon: '',
      wordCount: skillBody.split(/\s+/).filter(Boolean).length,
      syncedToDrive: false,
      enabled: false
    }, []);
    await linkDocumentToProject(projectId, id);
  } catch (e) {
    console.warn('Skill doc save failed (skill itself is registered):', e);
  }

  return { cmd: finalCmd, desc, systemPrompt };
}

async function handleDeepResearch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { projectId, topic, chatId } = request;
  const mode = (request.mode as 'quick' | 'deep') || 'quick';
  if (!projectId || !topic) throw new Error('projectId and topic are required');

  // One research run at a time: the job checkpoint is a singleton, and a
  // second run would stomp the first one's resume state. Chat stays usable
  // during a run — this only guards research-on-research. Crucially, the
  // guard has an escape hatch: an `active` record whose heartbeat went
  // stale is a DEAD run (worker killed, or wedged past its heartbeat), and
  // must be reclaimed here or no research can ever start again.
  if (abortControllers.has(projectId as string)) {
    throw new Error('A research run is already active. Press Stop first, or wait for it to finish.');
  }
  const runningJob = await getResearchJob().catch(() => null) as any;
  if (runningJob?.active) {
    const fresh = runningJob.lastHeartbeatAt && (Date.now() - runningJob.lastHeartbeatAt) < HEARTBEAT_STALE_MS;
    if (fresh) {
      throw new Error('A research run is already active. Press Stop first, or wait for it to finish.');
    }
    console.warn('[RESEARCH] Reclaiming stale active job (heartbeat dead) before new start');
    await clearResearchJob().catch(() => {});
  }

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

// A single LLM call may not run forever: a stalled connection (provider
// hangs, socket half-open) is indistinguishable from "thinking" without a
// deadline, and one stuck call freezes the whole run while the heartbeat
// keeps reporting it healthy.
const LLM_CALL_TIMEOUT_MS = 4 * 60 * 1000;
// Streaming variant: reset on every delta — generous silence budget so slow
// models survive, but a dead stream gets cut.
const LLM_STREAM_IDLE_MS = 3 * 60 * 1000;
// Run-level watchdog: no progress line for this long = the run is wedged in
// something a per-call deadline didn't cover. Abort loudly.
const RESEARCH_STALL_MS = 8 * 60 * 1000;
// Absolute wall-clock cap per run (incl. resumes within this worker).
const RESEARCH_MAX_WALL_MS = 60 * 60 * 1000;

/** Child signal that fires on parent abort OR a deadline. */
function deadlineSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (parent.aborted) ctl.abort();
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error('deadline')), ms);
  return {
    signal: ctl.signal,
    done: () => { clearTimeout(timer); parent.removeEventListener('abort', onAbort); }
  };
}

/** Run (or resume) a research job. Job checkpoint must already exist. */
async function executeResearch({ projectId, chatId, topic, effectiveTopic, mode }: ResearchParams): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  abortControllers.set(projectId, controller);
  const signal = controller.signal;

  // Workspace instructions apply to research too — prepended to every research
  // LLM call's system prompt so the report follows the workspace's conventions.
  const rp = await getProject(projectId).catch(() => null);
  const researchRules = rp?.rules?.trim()
    ? `--- WORKSPACE INSTRUCTIONS (always follow these) ---\n${rp.rules.trim()}\n--- END WORKSPACE INSTRUCTIONS ---\n\n`
    : '';

  // Every planning/analysis LLM call carries its own deadline; timing out
  // fails THAT call (callers all have fallbacks) instead of the whole run.
  const chatFn = async (s: string, u: string) => {
    const d = deadlineSignal(signal, LLM_CALL_TIMEOUT_MS);
    try {
      return await chatWithCustom(researchRules + s, [], u, d.signal);
    } finally {
      d.done();
    }
  };

  // Streaming synthesis: forward coalesced deltas so the panel renders the
  // report live during [SYNTHESIZING]. Deltas are droppable — the persisted
  // chat message written after completion is the source of truth. An idle
  // watchdog (reset per delta) cuts dead streams instead of waiting forever.
  const synthesisFn = async (sys: string, user: string): Promise<string> => {
    let full = '';
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let idleTimer = setTimeout(() => ctl.abort(new Error('stream idle timeout')), LLM_STREAM_IDLE_MS);
    try {
      await chatWithCustomStream(researchRules + sys, [], user, ctl.signal, (delta) => {
        full += delta;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctl.abort(new Error('stream idle timeout')), LLM_STREAM_IDLE_MS);
        chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_DELTA', projectId, delta }).catch(() => {});
      });
    } catch (e) {
      if (signal.aborted) throw e;      // user cancelled — don't retry
      if (full.length === 0) throw e;
      // Partial stream then failure: fall back to non-streaming call
      return chatFn(sys, user);
    } finally {
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', onAbort);
    }
    return full;
  };

  let lastProgressAt = Date.now();
  const onProgress = (status: string) => {
    lastProgressAt = Date.now();
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
  const runStartedAt = Date.now();
  const heartbeatInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo?.().catch(() => {});
    updateHeartbeat().catch(() => {});

    // Run-level watchdog: the heartbeat proves the WORKER is alive, not the
    // run. If no progress line has appeared for RESEARCH_STALL_MS, or the
    // run blew its wall-clock budget, abort so it fails loudly instead of
    // spinning forever behind a healthy-looking heartbeat.
    const stalled = Date.now() - lastProgressAt > RESEARCH_STALL_MS;
    const overtime = Date.now() - runStartedAt > RESEARCH_MAX_WALL_MS;
    if (stalled || overtime) {
      onProgress(stalled
        ? `[WATCHDOG] No progress for ${Math.round(RESEARCH_STALL_MS / 60000)} min — aborting the stuck run.`
        : `[WATCHDOG] Run exceeded ${Math.round(RESEARCH_MAX_WALL_MS / 60000)} min wall-clock budget — aborting.`);
      controller.abort(new Error('watchdog'));
    }
  }, 20000);

  // The panel doesn't await START_DEEP_RESEARCH's response (Chrome drops
  // sendResponse after ~5 min), so the DEEP_RESEARCH_DONE broadcast in the
  // finally is the ONLY completion signal the UI sees — it must carry the
  // failure reason, or a failed run renders as "✓ complete".
  let doneError: string | undefined;
  try {
    const result = await runDeepResearch(projectId, effectiveTopic, chatFn, onProgress, signal, mode, synthesisFn);

    // Persist the synthesis as an assistant message — this is what keeps
    // the chat session intact after research finishes.
    if (chatId) {
      const interpretedNote = effectiveTopic !== topic ? `*Interpreted as: "${effectiveTopic}"*\n\n` : '';
      // Truncate the heading topic to keep the report title readable
      const headingTopic = topic.length > 120 ? topic.slice(0, 117) + '…' : topic;
      await saveChatMessage({
        chatId,
        role: 'assistant',
        text: `## Deep Research: ${headingTopic}\n\n${interpretedNote}${result.synthesis}`,
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
    doneError = message;
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
    chrome.runtime.sendMessage({
      action: 'DEEP_RESEARCH_DONE', projectId, chatId,
      // A user Stop surfaces as an AbortError → 'Cancelled': report it as a
      // neutral cancel, not a failure.
      error: doneError === 'Cancelled' ? undefined : doneError,
      cancelled: doneError === 'Cancelled'
    }).catch(() => {});
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

