// ─────────────────────────────────────────────
// Background Service Worker — AI Research Assistant v2
// ─────────────────────────────────────────────
// Local-first storage (IndexedDB), multi-provider AI,
// source-grounded citation prompts, optional Drive sync.

import {
  saveDocument, listDocuments, updateDocumentSync,
  getUnsyncedDocuments, getChatHistory, clearChatHistory, saveChatMessage,
  linkDocumentToProject, getProject, listProjects,
  getChunkByAnchor, deleteOrphanDocuments, resetSyncStatus,
  saveDocImages, getDocImage, listDocImages
} from '../lib/db';
import { chunkDocument, makeDocShortId } from '../lib/chunker';
import type { EmbeddedImage } from '../lib/pdf-parser';
import { buildCitationContext, CITATION_SYSTEM_PROMPT, parseResponseCitations } from '../lib/citations';
import { buildFrontmatter, hasFrontmatter } from '../lib/frontmatter';
import { get as idbGet } from 'idb-keyval';
import { runDeepResearch, generateSubQuestions, scrapeUrl, isJunkUrl, gatherWebSnippets } from './deep-researcher';
import { harvestReferences } from '../lib/reference-harvest';
import { needsIntentResolution, formatHistoryForIntent, parseRepoUrl, selectTreePaths, formatTreeBlock, isChitchat, isRefusalAnswer, isStructureQuestion, isImplementationQuestion, findRepoUrlInText, isPageMetaQuestion, questionKeywords, mentionsPageDeixis, overlapsPage, isLocationDependent, isGeneralKnowledgeQuestion, timezoneToPlace, isAssistantMetaQuestion, RepoRef } from '../lib/query-intent';
import { sanitizeCliOutput, isCliErrorOutput, composeCliPrompt } from '../lib/cli-output';
import { stripSourcesFooter, stripAnySourcesFooter } from '../lib/format';
import { selectSemantic, fetchWithinBudget, parseRouterSelection, TOTAL_CTX_BUDGET, RerankFn, LinkRef, Selection } from '../lib/context-retrieval';
import { getResearchLimits } from '../lib/research-limits';
import { DEFAULT_COMPANION_MCP_URL, CLI_TEMPLATE_AUTO } from '../lib/settings';
import { looksLikeBuildLog, looksLikeDebugPage, extractLogHighlights } from '../lib/log-highlights';
import { addChunksToVectorStore, searchSessionChunks, resetSessionIndex, resetAllSessionIndexes, isConfidentMatch } from '../lib/vector-store';
import { replaceChunksForDoc } from '../lib/db';
import { pdfUrlToBody, pdfOpfsToBody, pdfBase64ToBody, ensureOffscreen as ensureOffscreenDoc, recreateOffscreen } from '../lib/pdf-parser';
import { setEnsureOffscreen, setRecreateOffscreen, sendToOffscreen } from '../lib/offscreen-client';
import { crumb, dumpCrashLog, installCrashHandlers, installCrumbReceiver } from '../lib/crash-log';
import { getProviderSettings, buildProviderHeaders, chatWithCustom, chatWithCustomStream, handleFetchCustomModels, chatWithTools, ToolDef } from './llm-client';
import { handleSearchLibrary, handleRecallDocs } from './library-handlers';
import { handleLinkDocument, handleUnlinkDocument, handleListDocuments, handleGetDocument, handleDeleteDocument, handleGetDocumentCount, handleUpdateDocumentSelection } from './document-handlers';
import { handleCreateProject, handleListProjects, handleGetProject, handleUpdateProject, handleDeleteProject, handleCreateChat, handleListChats, handleDeleteChat, handleUpdateChat } from './project-handlers';
import {
  startJob as startResearchJob, getJob as getResearchJob,
  clearJob as clearResearchJob, appendJobLog, incrementResumeAttempts,
  markJobActive, markJobFinished, updateHeartbeat, JOB_MAX_AGE_MS, HEARTBEAT_STALE_MS
} from '../lib/research-store';
import { enqueueResearch, dequeueResearch, getResearchQueue, clearResearchQueue } from '../lib/research-queue';
import { builtinCommandNames } from '../lib/commands';
import { handleTeach } from './teach';
import { wikipediaSearch, wikipediaPageSummary } from '../lib/free-apis';

// ─────────────────────────────────────────────
// Robust error handling & offscreen management
// ─────────────────────────────────────────────

// Global unhandled rejection handler - catches silent failures
self.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  const msg = String(err?.message || err || '');
  // During extension reload/offscreen teardown Chrome can reject in-flight
  // runtime messages with "No SW". It is lifecycle noise, not a bug in the
  // current worker instance; logging it as an SW crash scared users.
  if (msg === 'No SW') {
    event.preventDefault();
    return;
  }
  console.error('[SW] Unhandled rejection:', msg);
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
setRecreateOffscreen(recreateOffscreen);

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

// Sidepanel process health check. The renderer process (shared by sidepanel +
// offscreen) can be killed by Chrome OOM without the SW being notified.
// Periodically ping the sidepanel; if it's gone (and wasn't explicitly closed
// by the user), mark it closed so the next icon click reopens it fresh.
self.setInterval(async () => {
  for (const [tabId, open] of sidePanelOpen) {
    if (!open) continue;
    try {
      await chrome.runtime.sendMessage({ action: 'SIDEPANEL_HEALTH_CHECK' });
    } catch {
      // Sidepanel process is dead — mark closed so next click reopens
      sidePanelOpen.set(tabId, false);
    }
  }
}, 120_000);

// ─────────────────────────────────────────────
// Defaults and State
// ─────────────────────────────────────────────
const abortControllers = new Map<string, AbortController>();
// Research runs get their OWN controller map (keyed by projectId). Previously
// chat turns and research shared `abortControllers`, so any in-flight chat
// stream made the research-queue drainer think a run was busy — a wedged chat
// parked the whole queue forever.
const researchControllers = new Map<string, AbortController>();
// ProjectIds whose research run is in its STARTUP window (claimed but not yet
// registered in researchControllers / marked active). Claimed SYNCHRONOUSLY at
// message entry so two rapid START_DEEP_RESEARCH messages can't both pass the
// busy check before the first one's awaits land.
const researchStartsPending = new Set<string>();
// Accumulated answer text for chats currently streaming, keyed by chatId. Lets a
// sidepanel that mounts mid-answer (a per-tab panel just switched to) pull the
// in-flight text and keep streaming, instead of missing the whole answer.
const liveChatStreams = new Map<string, string>();

// Crash breadcrumbs: route uncaught errors here, and on startup print whatever
// was persisted before the previous run ended — so a reload after a crash shows
// what the worker/offscreen was doing when it died.
installCrashHandlers('sw');
// The offscreen document has no chrome.storage, so it forwards its crumbs here
// (this is where the PDF/embed/rerank crashes actually happen). Persist them.
installCrumbReceiver();
dumpCrashLog('[Magpie crashlog]').catch(() => {});
const SW_BOOT_AT = Date.now();
crumb('sw', 'service worker started', { build: 'parse-worker-fixed' });

// The offscreen doc can't read chrome.storage to learn the inference device, and
// can't watch it for changes — so we push changes to it from here (this context
// does have storage). See offscreen.ts SET_INFERENCE_DEVICE / GET_INFERENCE_DEVICE.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('inferenceDevice' in changes)) return;
  const device = changes.inferenceDevice.newValue === 'webgpu' ? 'webgpu' : 'wasm';
  chrome.runtime.sendMessage({ action: 'SET_INFERENCE_DEVICE', device }).catch(() => { /* offscreen not open */ });
});

// ─────────────────────────────────────────────
// Side Panel — PER-TAB, toggled on icon click
// ─────────────────────────────────────────────
// Each tab owns its panel state: off by default, opened by clicking the icon on
// THAT tab, and Chrome natively hides/re-shows it as you switch away/back. The
// global default is disabled so fresh tabs never inherit an open panel.
//
// Open-state is driven by a lifecycle port the sidepanel opens on mount (see
// App.tsx), keyed by tabId. The icon click only ever happens on the ACTIVE tab —
// where an open panel is visible and its port connected — so the map is accurate
// exactly where the toggle decision is made (hidden tabs may read stale; they
// re-report on re-show, when their panel document remounts).
const sidePanelOpen = new Map<number, boolean>();

// Disable the global default panel (manifest default_path) so the panel is
// per-tab opt-in. Runs at every SW start — idempotent, and per-tab options
// set below override this default.
chrome.sidePanel?.setOptions({ enabled: false }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  // NOTE: sidePanel.open() must be called synchronously inside this handler.
  // Any `await` before it drops the user-gesture context and Chrome rejects
  // the call ("may only be called in response to a user gesture").
  if (!chrome.sidePanel || typeof tab.id !== 'number') return;
  const tabId = tab.id;
  const isOpen = sidePanelOpen.get(tabId) ?? false;

  if (isOpen) {
    // Close THIS tab's panel by disabling its tab-scoped options.
    // No gesture needed here, so promises are fine.
    sidePanelOpen.set(tabId, false);
    chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
  } else {
    // Fire setOptions without awaiting, then open() while the gesture is live.
    chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    chrome.sidePanel.open({ tabId }).catch((e) => {
      console.warn('sidePanel.open failed:', e);
      // The renderer process was likely killed by OOM. Reload the entire
      // extension so the NEXT icon click starts from a clean state.
      chrome.runtime.reload();
    });
    sidePanelOpen.set(tabId, true);
  }
});

// Sidepanel lifecycle port — marks its TAB open while connected
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel-lifecycle') return;
  let trackedTabId: number | null = null;
  port.onMessage.addListener((m) => {
    if (m?.type === 'OPEN' && typeof m.tabId === 'number') {
      trackedTabId = m.tabId;
      sidePanelOpen.set(m.tabId, true);
    }
  });
  port.onDisconnect.addListener(() => {
    if (trackedTabId !== null) sidePanelOpen.set(trackedTabId, false);
  });
});

// Drop state for closed tabs so the map can't grow unbounded.
chrome.tabs?.onRemoved?.addListener((tabId) => { sidePanelOpen.delete(tabId); });

// ─────────────────────────────────────────────
// Declarative Net Request — Strip bot-detection headers for extension fetches
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.declarativeNetRequest) {
    const rules = [
      {
        id: 3,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' },
            { header: 'Sec-Ch-Ua', operation: 'remove' },
            { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }
          ]
        },
        condition: {
          urlFilter: '*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3],
      addRules: rules as any
    });
  }

  // Context-menu creation is not idempotent across extension reload/update.
  // Remove stale entries first so Chrome doesn't emit noisy
  // "Cannot create item with duplicate id …" runtime.lastError warnings.
  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => resolve()));

  chrome.contextMenus.create({
    id: 'capture-selection',
    title: 'Capture selection to Workspace',
    contexts: ['selection']
  }, () => void chrome.runtime.lastError);

  chrome.contextMenus.create({
    id: 'capture-page',
    title: 'Capture page to Library',
    contexts: ['page']
  }, () => void chrome.runtime.lastError);

  // Create workspace two-way sync alarm (every 5 minutes)
  chrome.alarms.create('sync-workspace', { periodInMinutes: 5 });

  // Migrate old brand folder name to Magpie
  const storage = await chrome.storage.local.get(['driveFolderName']);
  if (storage.driveFolderName === 'AI Research Assistant') {
    await chrome.storage.local.set({ driveFolderName: 'Magpie' });
  }
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

    // Auto sync to Drive in the background (silent and robust)
    try {
      await handleSyncToDrive();
    } catch {
      // Not authenticated or offline
    }
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
  if (request.action === 'toggle_sidepanel') {
    chrome.storage.local.get(['sidePanelOpen'], (res) => {
      const isOpen = !!res.sidePanelOpen;
      if (isOpen) {
        chrome.runtime.sendMessage({ action: 'close_sidepanel' }).catch(() => {});
        sendResponse({ success: true });
      } else {
        if (sender.tab && sender.tab.id) {
          chrome.sidePanel.open({ tabId: sender.tab.id })
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err) }));
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab?.id) {
              chrome.sidePanel.open({ tabId: activeTab.id })
                .then(() => sendResponse({ success: true }))
                .catch((err) => sendResponse({ success: false, error: String(err) }));
            } else {
              sendResponse({ success: false, error: 'No active tab found' });
            }
          });
        }
      }
    });
    return true;
  }

  if (request.action === 'capture_current_page_via_hotkey') {
    // Project linking goes through resolveLinkTarget inside captureTab (which
    // reads the idb active-project key AND honors autoLinkCaptures). The old
    // chrome.storage 'activeProjectId' read here was dead — nothing ever wrote
    // that key — and it bypassed the autoLinkCaptures toggle.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !tab.url) {
        if (sender.tab && sender.tab.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            action: 'SHOW_ONPAGE_TOAST',
            message: '✕ Capture failed: No active tab found',
            isError: true
          }).catch(() => {});
        }
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }

      captureTab(tab, null)
        .then(() => {
          chrome.tabs.sendMessage(tab.id!, {
            action: 'SHOW_ONPAGE_TOAST',
            message: `✓ Saved to Library`
          }).catch(() => {});
          chrome.runtime.sendMessage({ action: 'DOCUMENT_IMPORTED' }).catch(() => {});
          sendResponse({ success: true });
        })
        .catch((err: any) => {
          chrome.tabs.sendMessage(tab.id!, {
            action: 'SHOW_ONPAGE_TOAST',
            message: `✕ Capture failed: ${err.message || err}`,
            isError: true
          }).catch(() => {});
          sendResponse({ success: false, error: String(err?.message || err) });
        });
    });
    return true;
  }

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

import { startCopilotDeviceFlow, pollForAccessToken, saveCopilotAuth, isCopilotConfigured, signOutCopilot, setCopilotPending, getCopilotPending, refreshCopilotModels } from '../lib/copilot-auth';

type MessageHandler = (request: Record<string, unknown>, sender: chrome.runtime.MessageSender) => Promise<Record<string, unknown>>;

// Owns the device-code poll loop so it survives side-panel teardown. Every
// panel mirrors progress through the shared `magpie-copilot-pending` storage
// key rather than holding the promise itself.
async function runCopilotPoll(deviceCode: string, interval: number, expiresIn: number): Promise<void> {
  try {
    const token = await pollForAccessToken(deviceCode, interval, expiresIn);
    await saveCopilotAuth(token);
    const pending = await getCopilotPending();
    if (pending) await setCopilotPending({ ...pending, status: 'done' });
  } catch (e: any) {
    const pending = await getCopilotPending();
    if (pending) await setCopilotPending({ ...pending, status: 'error', error: e?.message || 'Sign-in failed' });
  }
}

const messageHandlers: Record<string, MessageHandler> = {
  // ── GitHub Copilot SSO ──
  // Start the device flow AND begin polling in the background. The panel only
  // opens the verification tab and mirrors status via storage — it never holds
  // the poll promise, so switching/closing tabs can't orphan the sign-in.
  COPILOT_START_DEVICE_FLOW: async () => {
    const codes = await startCopilotDeviceFlow();
    await setCopilotPending({
      userCode: codes.user_code,
      verificationUri: codes.verification_uri,
      deviceCode: codes.device_code,
      expiresAt: Date.now() + codes.expires_in * 1000,
      status: 'polling',
    });
    // Fire-and-forget: poll loop lives in the service worker.
    void runCopilotPoll(codes.device_code, codes.interval, codes.expires_in);
    return codes as any;
  },
  // Legacy/no-op: polling is now driven by COPILOT_START_DEVICE_FLOW. Kept so an
  // older panel build calling this still resolves once the background finishes.
  COPILOT_POLL_TOKEN: async () => {
    const pending = await getCopilotPending();
    if (pending?.status === 'done') return { success: true };
    if (pending?.status === 'error') return { success: false, error: pending.error };
    return { success: true, pending: true };
  },
  COPILOT_STATUS: async () => ({ configured: await isCopilotConfigured() }),
  COPILOT_SIGN_OUT: async () => { await signOutCopilot(); await setCopilotPending(null); return {}; },
  // Re-fetch the enterprise/org model list using a live session token —
  // distinct from FETCH_CUSTOM_MODELS, which uses the BYOK key/URL and would
  // send the Copilot sentinel key as a literal (invalid) API key.
  COPILOT_FETCH_MODELS: async () => {
    try {
      const { models, apiBase } = await refreshCopilotModels();
      return { success: true, models, apiBase };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Failed to fetch Copilot models' };
    }
  },

  ENSURE_OFFSCREEN: async () => {
    await ensureOffscreen();
    return {};
  },
  // Offscreen has no chrome.storage — it asks us for the inference device pref.
  GET_INFERENCE_DEVICE: async () => {
    const r = await chrome.storage.local.get('inferenceDevice');
    return { device: r?.inferenceDevice === 'webgpu' ? 'webgpu' : 'wasm' };
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
  TEACH: async (request) => {
    const ctx = (request as any).includePageContext ? await getPageContext().catch(() => null) : null;
    return handleTeach(request, ctx);
  },
  REINDEX_LIBRARY: handleReindexLibrary,
  RECALL_DOCS: handleRecallDocs,
  CLEANUP_ORPHANS: async () => {
    const deleted = await deleteOrphanDocuments();
    return { deleted };
  },

  // ── Chat ──
  CHAT_WITH_KNOWLEDGE: handleChatRemoved,
  GET_CHAT_HISTORY: handleGetChatHistory,
  // In-flight answer for a chat (for a panel that mounts mid-stream).
  GET_CHAT_STREAM: async (req: Record<string, unknown>) => {
    const chatId = req.chatId as string;
    return { generating: liveChatStreams.has(chatId), full: liveChatStreams.get(chatId) || '' };
  },
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
    const running = !!job && (researchControllers.has(job.projectId) || researchStartsPending.has(job.projectId) || (job.active && fresh));
    return { job, running };
  },

  // ── Local Markdown import ──
  IMPORT_LOCAL_MD: handleImportLocalMd,
  IMPORT_LOCAL_PDF: handleImportLocalPdf,
  IMPORT_LOCAL_IMAGES: handleImportLocalImages,

  // Resolve a magpie-img:// ref to a renderable data URL (DocumentView img).
  GET_DOC_IMAGE: async (request) => {
    const docId = request.docId as string;
    const imgId = request.imgId as string;
    if (!docId || !imgId) throw new Error('docId and imgId are required');
    const img = await getDocImage(docId, imgId);
    if (!img) return { found: false };
    return { found: true, dataUrl: await blobToDataUrl(img.blob), width: img.width, height: img.height };
  },

  // All images of a doc (export materialization): id → dataUrl.
  LIST_DOC_IMAGES: async (request) => {
    const docId = request.docId as string;
    if (!docId) throw new Error('docId is required');
    const imgs = await listDocImages(docId);
    const out: Array<{ imgId: string; dataUrl: string }> = [];
    for (const im of imgs) out.push({ imgId: im.imgId, dataUrl: await blobToDataUrl(im.blob) });
    return { images: out };
  },


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
  RESET_SYNC_STATUS: async () => {
    const resetCount = await resetSyncStatus();
    return { resetCount };
  },
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
  /** Set when the page is a PDF viewer (e.g. ACM /doi/epdf/…) — capture the PDF. */
  pdfUrl?: string;
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
const PAGE_CONTEXT_TTL_MS = 2 * 60 * 1000;

// Depth counter set while an interactive chat turn is assembling context.
// The embedder is one serialized WASM context (see offscreen-client mutex);
// during a deep-research run the queue fills with the run's batches. Marking a
// chat turn's embeds `priority` lets them jump ahead so the panel never freezes
// waiting minutes for the run to release the model. It's a depth (not a bool)
// because concurrent chat turns (two side panels) can overlap.
let interactiveDepth = 0;
const embedOpts = () => ({ priority: interactiveDepth > 0 });

// Constants for page context are now handled by the head+section-index injection
// + read_section/search_page/read_lines tools in agenticGather.

/**
 * Build the page markdown to inline into the chat request. Short pages go in
 * whole. Long pages (2-hour transcripts, full PDFs) switch to retrieval:
 * chunk once, embed once (cached alongside the page for the TTL), then per
 * question cosine-rank and inline only the most relevant sections — the old
 * head+tail truncation silently dropped the middle of long videos.
 * Everything stays in memory; nothing touches IndexedDB or the search index.
 * Obsolete: replaced by head+section-index injection + read_section/search_page/read_lines
 * tools in the agentic gather phase (see agenticGather).
 */

async function getPageContext(): Promise<PageContext | null> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) return null;

  const cached = pageContextCache.get(tab.url);
  // Freshness: a short TTL, AND the tab's live title must still match the cached
  // scrape. SPA sites (HF, hosted report viewers) swap content while keeping the
  // same URL — a stale 5-min cache then made the model describe the PREVIOUS
  // page ("not what I described before"). A title change is a cheap re-scrape signal.
  if (cached && Date.now() - cached.ts < PAGE_CONTEXT_TTL_MS
      && (!tab.title || tab.title === cached.ctx.title)) {
    return cached.ctx;
  }

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

  // PDF-viewer page (e.g. ACM /doi/epdf/…): the scrape is useless viewer HTML.
  // Have the content script fetch the actual PDF from the page (so it carries the
  // user's session cookies) and capture that instead. Fall through on failure.
  if (scraped?.pdfUrl) {
    const captured = await captureEmbeddedPdf(linkTarget, tab, scraped.pdfUrl, scraped.title).catch((e) => {
      console.warn('[capture] embedded PDF capture failed, falling back to page scrape:', e);
      return null;
    });
    if (captured) return captured;
  }

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

  // Auto sync to Drive in the background
  handleSyncToDrive().catch(() => {});

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
      // Inline data-URL images are EXTRACTED to the docImages blob store and
      // replaced with magpie-img:// refs (replaces the old "(embedded-image)"
      // placeholder hack): stored content stays small, chunk text exactly
      // matches stored content (no offset divergence), images view + export.
      const withFm = hasFrontmatter(file.content)
        ? file.content
        : null; // frontmatter applied below once wordCount is known
      const extracted: Array<{ imgId: string; dataUrl: string }> = [];
      const extractImages = (text: string) => text.replace(/!\[([^\]]*)\]\((data:image\/[^)\s]+)\)/g, (_m, alt, du) => {
        const imgId = `md.${extracted.length + 1}`;
        extracted.push({ imgId, dataUrl: du });
        return `![${alt}](magpie-img://${imgId})`;
      });
      const stripped = extractImages(file.content);
      const wordCount = stripped.split(/\s+/).filter(Boolean).length;
      const content = withFm ?? (buildFrontmatter({ title, type: 'local-import', source: 'local-file', wordCount }) + stripped);
      const chunks = chunkDocument({ docShortId, content });

      const { id: docId, chunks: savedChunks } = await saveDocument({
        title,
        url: '',
        content,
        capturedAt: new Date().toISOString(),
        favicon: '',
        wordCount,
        syncedToDrive: false
      }, chunks);

      if (extracted.length) {
        const blobs = await Promise.all(extracted.map(async im => ({ imgId: im.imgId, blob: await dataUrlToBlob(im.dataUrl) })));
        await saveDocImages(docId, blobs).catch(e => console.warn('saveDocImages failed', e));
      }

      await linkDocumentToProject(projectId, docId);
      await addChunksToVectorStore(projectId, savedChunks);
      imported++;
    } catch (err) {
      errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Auto sync to Drive in the background
  handleSyncToDrive().catch(() => {});

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
  const pdfImages: EmbeddedImage[] = [];

  try {
    body = await pdfUrlToBody(url, imageToText, false, pdfImages);
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
    pdfImages.length = 0; // Jina markdown has no extracted figures
  }

  const nameFromUrl = decodeURIComponent(url.split('/').pop() || 'PDF').replace(/\.pdf.*$/i, '');
  // Chrome's PDF viewer usually puts the filename or document title in tab.title
  const title = (tab.title && tab.title.trim() && tab.title !== url)
    ? tab.title.replace(/\.pdf$/i, '').trim()
    : nameFromUrl;
  return savePdfDocument(projectId, url, title, tab.favIconUrl || '', body, pdfImages);
}

/** Persist a parsed PDF body as a first-class `pdf` document (+ vector store). */
async function savePdfDocument(
  projectId: string | null, url: string, title: string, favicon: string, body: string,
  images?: EmbeddedImage[],
): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const fullMarkdown = buildFrontmatter({ title, type: 'pdf', source: url, captured: now, wordCount }) + body;
  const tempId = crypto.randomUUID?.() ?? `${Date.now()}`;
  const chunks = chunkDocument({ docShortId: makeDocShortId(tempId), content: fullMarkdown });
  const { id: docId, chunks: savedChunks } = await saveDocument({
    title, url, content: fullMarkdown, capturedAt: now, favicon, wordCount, syncedToDrive: false,
  }, chunks);
  // Embedded figures land in the docImages store; the markdown already
  // references them via magpie-img://{imgId} (doc-relative).
  if (images?.length) {
    const blobs = await Promise.all(images.map(async im => ({
      imgId: im.imgId, blob: await dataUrlToBlob(im.dataUrl), width: im.width, height: im.height,
    })));
    await saveDocImages(docId, blobs).catch(e => console.warn('saveDocImages failed', e));
  }
  if (projectId) {
    await linkDocumentToProject(projectId, docId);
    await addChunksToVectorStore(projectId, savedChunks);
  }
  return { docId, title, chunkCount: chunks.length, linkedTo: projectId };
}

/**
 * Capture a PDF embedded in a viewer page (ACM /doi/epdf/…, etc.). The content
 * script fetches the bytes from the page (session cookies → paywalled PDFs work)
 * and returns base64; we parse it locally and save it. Returns null so the caller
 * falls back to a normal page scrape if there's no usable PDF.
 */
async function captureEmbeddedPdf(
  projectId: string | null, tab: chrome.tabs.Tab, pdfUrl: string, fallbackTitle: string,
): Promise<Record<string, unknown> | null> {
  if (!tab.id) return null;
  const ex: any = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id!, { action: 'EXTRACT_PDF', url: pdfUrl }, (r) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
    });
  });
  if (!ex?.ok || !ex.base64) {
    console.warn('[capture] EXTRACT_PDF:', ex?.error || 'no bytes');
    return null;
  }
  const pdfImages: EmbeddedImage[] = [];
  const body = await pdfBase64ToBody(ex.base64 as string, imageToText, false, pdfImages);
  const textOnly = body.replace(/## Page \d+/g, '').replace(/\*\(no extractable text\)\*/g, '').trim();
  if (textOnly.length < 50) throw new Error('captured PDF had no extractable text (scanned — try Import PDF)');
  const title = ((ex.title as string) || fallbackTitle || (ex.url as string) || pdfUrl).replace(/\.pdf$/i, '').trim();
  return savePdfDocument(projectId, (ex.url as string) || pdfUrl, title, tab.favIconUrl || '', body, pdfImages);
}

/** Save one processed document (text) into IndexedDB + vector store + project. */
async function saveProcessedDoc(projectId: string, title: string, content: string, images?: EmbeddedImage[]): Promise<string> {
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
  if (images?.length) {
    const blobs = await Promise.all(images.map(async im => ({
      imgId: im.imgId, blob: await dataUrlToBlob(im.dataUrl), width: im.width, height: im.height,
    })));
    await saveDocImages(docId, blobs).catch(e => console.warn('saveDocImages failed', e));
  }
  await linkDocumentToProject(projectId, docId);
  await addChunksToVectorStore(projectId, savedChunks);
  return docId;
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

        const pdfImages: EmbeddedImage[] = [];
        const body = await pdfOpfsToBody(file.opfsName, file.size, imageToText, false, pdfImages);
        const content = buildFrontmatter({
          title, type: 'pdf', source: 'local-pdf',
          wordCount: body.split(/\s+/).filter(Boolean).length
        }) + body;
        await saveProcessedDoc(projectId, title, content, pdfImages);
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
    handleSyncToDrive().catch(() => {});
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
    handleSyncToDrive().catch(() => {});
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
    researchControllers.get(projectId)?.abort();
    researchControllers.delete(projectId);
    researchStartsPending.delete(projectId);
    // Stop is a FORCE-clear, not just an abort: a run wedged in a
    // non-abortable await (hung offscreen call, stalled stream) never
    // reaches its cleanup `finally`, leaving the active job record
    // blocking every future run. Clear it here unconditionally — if the
    // zombie promise ever settles, its own cleanup is a no-op.
    await markJobFinished().catch(() => {});
    await clearResearchJob().catch(() => {});
    // Stop means stop ALL research — also drop anything queued behind this run, so
    // the aborted run's finally-drain doesn't auto-start the next one.
    const queuedBeforeStop = await getResearchQueue().catch(() => []);
    await clearResearchQueue().catch(() => {});
    if (queuedBeforeStop.length > 0) {
      chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_LOG', projectId, status: `[QUEUE] Stopped — cleared ${queuedBeforeStop.length} queued research run(s).` }).catch(() => {});
    }
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
    const sys = `Rewrite the user's latest message as ONE standalone, search-friendly question. Resolve pronouns and references ("it", "this page", "the skill") using the conversation${pageTitle ? ' and the page they are viewing' : ''}. Keep the user's intent exactly — do not answer, broaden, or narrow it. Keep the SAME language as the user's message. Return ONLY the rewritten question.`;
    const user = `${pageTitle ? `Page being viewed: ${pageTitle}\n\n` : ''}Conversation:\n${formatHistoryForIntent(formattedHistory)}\n\nLatest message: ${prompt}`;
    const rewritten = (await withTimeout(
      chatWithCustom(sys, [], user, signal, await classificationModel()),
      INTENT_LLM_TIMEOUT_MS,
      'intent resolution'
    )).trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
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

/**
 * Optional fast model for classification/intent calls (routing, question
 * rewriting, page-relevance). Falls back to the main chat model when unset.
 * Users configure it once in Settings — "gpt-4o-mini" / "claude-haiku" / etc.
 */
async function getClassificationModel(): Promise<string | undefined> {
  try {
    const s = await chrome.storage.local.get(['classificationModel']);
    return (s.classificationModel as string)?.trim() || undefined;
  } catch { return undefined; }
}

// Module-level cache — only invalidates when user changes settings.
let _cachedClassModel: string | undefined | null = null;
async function classificationModel(): Promise<string | undefined> {
  if (_cachedClassModel !== null) return _cachedClassModel;
  _cachedClassModel = await getClassificationModel();
  // Watch for settings changes so the cache stays fresh.
  chrome.storage.onChanged.addListener((changes) => {
    if ('classificationModel' in changes) _cachedClassModel = null;
  });
  return _cachedClassModel;
}

/**
 * Should the answer show a "Sources:" footer for WEB pages (web-search results,
 * auto-followed page links)? Default OFF: users asked for the Sources footer to
 * mean "from my saved library", not weather sites / followed webpages. The
 * library citation footer (clickable [1] chips → open the stored doc) is
 * unaffected — this only governs the web/page-URL trail.
 */
/** Build the RAG system prompt + formatted history for a chat turn. */
/**
 * Intent router for an attached page (📄 ON): is this question actually ABOUT
 * the page, or an unrelated general question ("is it cold today?") that only
 * dead-ends if forced through the page path? Instant heuristics decide the
 * common cases (explicit page reference, or a keyword shared with the page);
 * only a genuinely ambiguous question costs one cheap classification call.
 * Fails OPEN to the page — the user did attach it.
 */
// Cache the LLM classification (the only slow part of the router) per page+
// question, so re-asking / follow-ups on the same page don't pay the extra
// serial call each turn. Heuristic hits are instant and skip this entirely.
const pageRelevanceCache = new Map<string, { val: boolean; ts: number }>();
const PAGE_RELEVANCE_TTL_MS = 5 * 60 * 1000;

async function isQuestionAboutPage(q: string, page: PageContext, signal: AbortSignal): Promise<boolean> {
  // Weather / "near me" / local asks are about the world, not the open page —
  // route them out even if the page happens to contain a matching word.
  if (isLocationDependent(q)) return false;
  // Questions about the assistant itself ("do you support kurdish?") are never
  // page questions, even when the page shares the keyword (a Kurdish-region
  // travel page must not hijack them). Belt-and-braces: buildChatRequest
  // intercepts the raw prompt, this catches intent-rewritten forms.
  if (isAssistantMetaQuestion(q)) return false;
  if (mentionsPageDeixis(q)) return true;
  if (overlapsPage(q, `${page.title} ${page.markdown.slice(0, 4000)}`)) return true;

  const key = `${page.url}::${q.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)}`;
  const cached = pageRelevanceCache.get(key);
  if (cached && Date.now() - cached.ts < PAGE_RELEVANCE_TTL_MS) return cached.val;

  try {
    const sys =
      `You are an intent router. The user is viewing a web page titled "${page.title}". ` +
      `Decide whether their question is about THIS page (its subject, site, or content) or is an unrelated general question ` +
      `— weather, math, world facts, another website, personal chit-chat. Reply with exactly one word: PAGE or OTHER.`;
    const ans = await withTimeout(
      chatWithCustom(sys, [], q, signal, await classificationModel()),
      INTENT_LLM_TIMEOUT_MS,
      'page relevance check'
    );
    // Only an explicit PAGE verdict routes to the page. An unparseable answer
    // (refusal, prose, empty string) is AMBIGUOUS — the old fail-open treated
    // garbage as PAGE and forced unrelated questions through the page path.
    const val = /\bPAGE\b/i.test(ans) && !/\bOTHER\b/i.test(ans);
    if (pageRelevanceCache.size > 200) pageRelevanceCache.clear(); // bound memory
    pageRelevanceCache.set(key, { val, ts: Date.now() });
    return val;
  } catch (e) {
    if (signal.aborted) throw e;
    // Provider hiccup: prefer the heuristic result (keyword overlap already
    // said no) over honoring the page blindly — a misrouted turn is worse
    // than an ungrounded one.
    return false;
  }
}

/** Which pipeline produced the turn's system prompt. `general` lets the
 *  streaming layer emit the "answering from general knowledge" disclosure
 *  deterministically instead of trusting the model to include it. */
type ChatBranch = 'chitchat' | 'meta' | 'no-page' | 'citation' | 'page' | 'web' | 'general';

// The languages/tone rule for EVERY chat branch. Small models default to the
// system prompt's language (English) — without this, a Kurdish/Finnish/… user
// gets English answers, or worse, wrong-language text labeled as theirs.
const LANGUAGE_RULE =
  ` ALWAYS write your answer in the language of the user's latest message — or the language they explicitly ask for — ` +
  `even when the sources, page, or these instructions are in another language. Never claim you cannot chat in a language you can write.`;

async function buildChatRequest(chatId: string, projectId: string, prompt: string, signal: AbortSignal, pageContext?: PageContext | null, onStatus?: (s: string) => void): Promise<{ systemPrompt: string; formattedHistory: Array<{ role: string; content: string }>; grounded: boolean; place?: string; branch: ChatBranch }> {
  // BATCH: workspace docs, project rules, locale, history, web-fallback — five
  // separate async sources that previously ran as five sequential awaits. Run
  // them concurrently where possible. History must land first (formattedHistory
  // is built from it), but it can fetch in parallel with the others.
  const [allDocs, project, locStore, history, chatWebFallback] = await Promise.all([
    listDocuments(projectId),
    getProject(projectId).catch(() => null),
    chrome.storage.local.get(['userLocation', 'araTimezone']),
    getChatHistory(chatId),
    isChatWebFallbackEnabled(),
  ]);
  const enabledDocs = allDocs.filter((d: any) => d.enabled !== false);
  const docIds = enabledDocs.map((d: any) => d.id);
  const docTitles = new Map(enabledDocs.map((d: any) => [d.id, d.title]));
  console.log(`[RAG] Project ${projectId}: ${enabledDocs.length} enabled docs, ${docIds.length} IDs`);

  const rulesBlock = project?.rules?.trim()
    ? `--- WORKSPACE INSTRUCTIONS (always follow these for this workspace) ---\n${project.rules.trim()}\n--- END WORKSPACE INSTRUCTIONS ---\n\n`
    : '';

  // User locale context — an approximate place (explicit setting, else derived
  // from the system timezone) + timezone, so location/time-dependent questions
  // ("weather today", "near me") use the user's own region instead of the search
  // provider's IP geolocation. Coarse by design (city/region, never precise).
  const userLocation = (locStore as any).userLocation;
  const araTimezone = (locStore as any).araTimezone;
  // Prefer the timezone captured by the sidepanel (a real document): MV3 service
  // workers can report Intl timeZone as "UTC", which would blank out the place
  // and make the model ask "what's your city?". Fall back to the worker's own.
  const swTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const tz = String(araTimezone || '').trim() || swTz;
  const place = String(userLocation || '').trim() || timezoneToPlace(tz);
  const localeBlock = place
    ? `--- USER CONTEXT (use for location/time-dependent questions; don't ask the user where they are) ---\n` +
      `Today's date: ${new Date().toISOString().slice(0, 10)}.\n` +
      `Approximate location: ${place}${userLocation ? '' : ' (inferred from the system timezone — flag the assumption if relevant)'}.` +
      `${tz ? ` Timezone: ${tz}.` : ''}\n--- END USER CONTEXT ---\n\n`
    : '';

  // Build formatted history from the already-fetched history (batched above).
  const formattedHistory = history
    .filter((msg: any) => msg.role === 'user' || msg.role === 'assistant')
    // Strip the deterministic "*Sources:*" footer from saved assistant turns.
    // Fed back verbatim, the model learns the pattern and appends its own copy
    // — which then doubles with the footer the stream layer adds (observed:
    // two identical "Sources:" lines on one answer).
    .map((msg: any) => ({ role: msg.role, content: stripSourcesFooter(msg.text) }))
    // Sliding window: keep only the most recent turns so long chats don't
    // balloon prompt size → slow TTFT.
    .slice(-MAX_HISTORY_TURNS);

  // Greetings / small talk must NOT run retrieval: it returns weak top-k
  // chunks that trip the strict "I cannot answer from the sources" refusal
  // (so "hi" got refused), and its query embedding would queue behind an
  // active research run at the offscreen embedder. Answer conversationally.
  // A greeting stays a greeting even with a web page open — an open tab
  // doesn't turn "hi" into a question, so don't gate this on pageContext.
  //
  // Only use the onboarding-style invite at conversation START. Mid-conversation
  // "ok"/"thanks"/"hi" gets a brief conversational reply instead.
  if (isChitchat(prompt)) {
    onStatus?.('Writing the answer…');
    const isFresh = formattedHistory.length < 2;
    const systemPrompt = rulesBlock +
      (isFresh
        ? `You are Magpie, a warm, concise research assistant. The user sent a greeting or small talk — NOT a research question. ` +
          `Reply in ONE friendly sentence, then briefly invite them to ask about their captured sources or to run /research <topic>. ` +
          `Do NOT mention "sources" as though they asked a question, and do NOT say you can't answer. Never add a "Sources:" line.`
        : `You are Magpie, a research assistant. The user sent small talk — keep your reply to ONE short, friendly sentence. ` +
          `Do not invite them to do anything, do not mention sources, and do not ask follow-up questions. Never add a "Sources:" line.`) +
      LANGUAGE_RULE;
    return { systemPrompt, formattedHistory, grounded: false, branch: 'chitchat' };
  }

  // Questions about the ASSISTANT itself ("do you support kurdish?", "what can
  // you do?") answer conversationally — no page, no retrieval, no web search.
  // Without this, "do you support kurdish?" with a Kurdish-region travel page
  // attached keyword-matched the page and got answered as a page question.
  if (isAssistantMetaQuestion(prompt)) {
    onStatus?.('Writing the answer…');
    const systemPrompt = rulesBlock +
      `You are Magpie, a research assistant that lives in the user's browser side panel. The user is asking about YOU — ` +
      `your capabilities, languages, or identity — NOT about the open page or their sources; do not answer from those. ` +
      `Answer honestly and concisely. You are multilingual: you can chat in whatever language the user writes or requests ` +
      `(including Kurdish — Sorani and Kurmanji), you answer questions from their captured sources and the page they attach with 📄, ` +
      `you can search the web, and you run deep research via /research <topic>.` +
      LANGUAGE_RULE;
    return { systemPrompt, formattedHistory, grounded: false, branch: 'meta' };
  }

  // Weather, time, math, trivia, facts — questions that need live data or
  // general knowledge, NOT the user's saved sources. Skip ALL retrieval
  // (source search, page analysis, agentic routing) and go straight to web
  // or general knowledge. Avoids wasted embeddings + reranking (+ offscreen
  // queue wait) for "what's the weather like today?".
  if (isGeneralKnowledgeQuestion(prompt)) {
    onStatus?.('Looking it up…');
    const q = prompt;
    const branch: ChatBranch = 'general';
    // Probe web immediately with localized query — no source search first.
    if (chatWebFallback) {
      onStatus?.('Searching the web…');
      try {
        const webQuery = place && isLocationDependent(q) ? `${q} ${place}` : q;
        const web = await gatherWebSnippets(webQuery, { signal, onStatus }).catch(() => null);
        if (web?.context) {
          const systemPrompt = rulesBlock +
            `You are a helpful assistant. The excerpts below were pulled from a live web search just now — treat them as your facts. ` +
            `Answer concisely in natural language. Do not fabricate citations.` + LANGUAGE_RULE +
            `\n--- WEB RESULTS ---\n${web.context}\n--- END WEB RESULTS ---`;
          return { systemPrompt, formattedHistory, grounded: false, place, branch: 'web' };
        }
      } catch (e) {
        if (signal.aborted) throw e;
      }
    }
    // Web failed — try Wikipedia for structured general knowledge (free, no key,
    // high quality for facts, definitions, history, people, places).
    try {
      const wikiHits = await wikipediaSearch(q, signal);
      if (wikiHits.length > 0) {
        // Try to get the full first summary for richer context.
        const firstTitle = wikiHits[0].title;
        let wikiContext = wikiHits.map((h, i) => `[W${i+1}] ${h.title}\n${h.snippet}`).join('\n\n');
        if (firstTitle) {
          const summary = await wikipediaPageSummary(firstTitle, signal);
          if (summary) wikiContext = `**${firstTitle}**\n\n${summary}`;
        }
        const systemPrompt = rulesBlock + localeBlock +
          `You are a helpful assistant. The following information was retrieved from Wikipedia — treat it as factual. ` +
          `If Wikipedia covers the general concept but the user asked about current conditions (weather, time, news), ` +
      `still provide the best answer using your general knowledge — do not refuse. ` +
          `you may supplement from your own knowledge. Answer concisely.` + LANGUAGE_RULE +
          `\n--- WIKIPEDIA ---\n${wikiContext}\n--- END WIKIPEDIA ---`;
        return { systemPrompt, formattedHistory, grounded: false, place, branch: 'web' };
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
    // Web + Wikipedia both failed — fall back to general knowledge.
    const systemPrompt = rulesBlock + localeBlock +
      `You are a helpful AI assistant. Answer using your general knowledge. ` +
      `If asked about current weather, time, date, or news, provide the best answer you can from what you know. ` +
      `Never say you don't have access to current data or real-time information — just answer based on your training. ` +
      `Be concise — the user wants a quick fact, not an essay.` + LANGUAGE_RULE;
    return { systemPrompt, formattedHistory, grounded: false, place, branch };
  }

  // Follow-up questions get rewritten into standalone ones so retrieval,
  // page-section selection, and link scoring all see real signal.
  if (needsIntentResolution(prompt, formattedHistory.length)) onStatus?.('Understanding the question…');
  const effectiveQuery = await resolveQuestionIntent(prompt, formattedHistory, pageContext?.title, signal);

  // Intent router: an attached page only wins when the question is actually
  // about it. "is it cold today?" with a docs page open must NOT be forced
  // through the page path (→ "the page doesn't cover weather"); route it to the
  // normal workspace/web/general pipeline instead.
  //
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
    `\nRESPONSE STYLE — write for a busy reader in a narrow side panel. Prioritise SCANNABILITY:\n` +
    `• Lead with the answer. NO preamble, no "Certainly!/Great question!", no sycophancy, no closing summary or "if you want, I can…" offers.\n` +
    `• Use REAL Markdown, always: '## ' for section headings (not bold-as-heading, not plain lines), '- ' for bullet lists, '1. ' for ordered steps, '**bold**' for the key term at the start of a bullet, and Markdown tables for comparisons. Put a blank line between every heading, paragraph and list.\n` +
    `• Keep paragraphs to 1-3 short sentences. Break anything longer into bullets. Never write a wall of text.\n` +
    `• Plain, concrete language — "it's 19°C, feels like 13°", not "the temperature is considered cold". Define a term in a half-sentence the first time; don't assume nor over-explain.\n` +
    `• Match length to the ask: a definition = 2-4 sentences; a list question = a tight bulleted list; a comparison = a table. Answer only what was asked.\n` +
    `• FAIL FAST: if the sources/page don't contain what's needed, say so in ONE line — never guess persuasively.\n` +
    `• When fixing an error, name the ROOT CAUSE before the fix.\n` +
    `• Do NOT end with a "Sources:" line or a list of URLs — the app shows sources separately.\n` +
    `•${LANGUAGE_RULE}`;

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
  const groundOnWorkspace = !usePage &&
    !isLocationDependent(effectiveQuery) &&
    isConfidentMatch(relevantChunks as Array<{ rerankScore?: number }>);
  if (groundOnWorkspace) {
    grounded = true;
    // Build citation-anchored context (generous — favor fuller grounding over
    // "I couldn't find it" cutoffs; only fires for library-source questions).
    const context = buildCitationContext(relevantChunks, docTitles, 32000);

    // We add strict anti-hallucination prompts to the system prompt
    systemPrompt = CITATION_SYSTEM_PROMPT +
      `\nCRITICAL ANTI-HALLUCINATION RULE: If the answer cannot be found in the provided sources, reply with ONLY NO_SOURCES_IN_WORKSPACE. DO NOT rely on external knowledge.\n` +
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
      `If the page doesn't cover the question, say so in one line rather than guessing or padding with unrelated facts. ` +
      `Do NOT end your reply with a "Sources:" line or list of URLs — sources are shown separately by the app.` +
      RESPONSE_STYLE;
  } else if (!pageContext && mentionsPageDeixis(effectiveQuery)) {
    // "What does this page say?" with NO page attached: a web search for that
    // phrasing returns arbitrary pages (observed: IBM Granite results appended
    // as Sources under an unrelated answer). Explain the situation instead.
    systemPrompt =
      `You are Magpie, a research assistant in the user's browser side panel. The user asked about "this page" but NO page is attached to this chat. ` +
      `Tell them, in one or two friendly sentences, to open the page in the browser and toggle 📄 ON (or paste a URL/text) so you can read it. ` +
      `Do NOT guess what the page might be, and do NOT answer from unrelated knowledge.` +
      RESPONSE_STYLE;
    onStatus?.('Writing the answer…');
    return { systemPrompt: rulesBlock + localeBlock + systemPrompt, formattedHistory, grounded: false, place, branch: 'no-page' };
  } else {
    // No workspace match and no open page. Before conceding to stale "general
    // knowledge", escalate to a quick live web search (+ any enabled search
    // MCPs) unless the user turned it off.
    let web: { context: string; sources: Array<{ title: string; url: string }> } = { context: '', sources: [] };
    if (chatWebFallback) {
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
        `Use only what the excerpts support; if they don't actually answer the question, say so plainly rather than padding. ` +
        `Do NOT end your reply with a "Sources:" line or a list of URLs — the app shows sources separately.` +
        RESPONSE_STYLE +
        `\n--- WEB RESULTS ---\n${web.context}\n--- END WEB RESULTS ---`;
    } else {
      console.warn(`[RAG] No confident workspace match for project ${projectId} — falling back to general knowledge`);
      // General conversation fallback. The "answering from general knowledge"
      // disclosure is EMITTED by the streaming layer (branch === 'general'), not
      // requested here — small models skipped the instruction, leaving users
      // unable to tell a sourced answer from a from-memory one.
      systemPrompt = `You are a helpful AI assistant. No relevant documents were found in the user's research workspace for this question. ` +
        `Answer using your general knowledge. Do not fabricate citations.` +
        RESPONSE_STYLE;
    }
  }

  // Ephemeral page context: the tab the user is looking at right now.
  // Deliberately fenced off from library sources — it has no citation
  // anchors and is never persisted.
  // Web-fallback sources render as the same clickable footer as auto-followed
  // links (streamed as a final delta + saved with the message).
  if (pageContext && usePage) {
    onStatus?.('Reading the page…');
    const md = pageContext.markdown;

    // For short pages, send the full content. For long pages, send the head
    // (first 4K chars) + a section index so the model can request specific
    // sections via the agentic read_section tool instead of dumping everything.
    const MAX_HEAD = 4000;
    let pageBlock: string;
    if (md.length <= MAX_HEAD) {
      pageBlock = md;
    } else {
      // Extract section headings for the index
      const headingRe = /^(#{1,4})\s+(.+)$/gm;
      const headings: string[] = [];
      let hMatch: RegExpExecArray | null;
      while ((hMatch = headingRe.exec(md)) !== null) {
        headings.push(hMatch[2].trim());
      }
      const head = md.slice(0, MAX_HEAD);
      const sectionIdx = headings.length > 2
        ? `\n\nThe page has ${headings.length} sections total. The first few are shown above. ` +
          `If you need to read a specific section, the user can ask or you can call read_section during enrichment.\n` +
          `All section headings: ${headings.slice(0, 30).map(h => `"${h}"`).join(', ')}${headings.length > 30 ? '…' : ''}`
        : '';
      pageBlock = head + sectionIdx;
    }

    systemPrompt +=
      `\n\n--- CURRENT PAGE (the user is viewing this in their browser right now; it is NOT saved in their library) ---\n` +
      `Title: ${pageContext.title}\nURL: ${pageContext.url}\n\n${pageBlock}\n` +
      `--- END CURRENT PAGE ---\n` +
      (looksLikeDebugPage(pageContext.markdown)
        ? `You are a smart debugger. Analyze the page content above to find the ROOT CAUSE. ` +
          `Start by looking at any error message, traceback, or diff shown above. ` +
          `If the head doesn't contain the error, the enrichment phase will read the deeper sections. ` +
          `Be thorough: name the exact error, what file/line caused it, what was expected vs received. ` +
          `Do not make up details not in the page.\n`
        : `Only answer from the CURRENT PAGE content above. Do NOT use your own knowledge. If the page does not contain the specific answer, say so — do not make up file names, line numbers, error messages, or any other details that are not in the page content. `) +
      `Attribute such claims in plain text, e.g. "according to the page you're viewing". ` +
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
    // NOTE: the repo URL comes from page CONTENT (attacker-influenceable), so its
    // fetched files are DATA, not instructions — the same RAG-injection surface
    // as any followed link. parseRepoUrl allow-lists hosts (github/gitlab/…) and
    // getRepoTree only hits their public read APIs, which bounds the exposure.
    const { enterpriseGitHubUrl } = await chrome.storage.local.get(['enterpriseGitHubUrl']).catch(() => ({})) as Record<string, any>;
    const enterpriseHost = (enterpriseGitHubUrl && typeof enterpriseGitHubUrl === 'string')
      ? new URL(enterpriseGitHubUrl).hostname : undefined;
    let repoRef = parseRepoUrl(pageContext.url, enterpriseHost);
    if (!repoRef && isImplementationQuestion(effectiveQuery)) {
      const linked = findRepoUrlInText(pageContext.markdown, enterpriseHost);
      const linkedRef = linked ? parseRepoUrl(linked, enterpriseHost) : null;
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
      enrich = await agenticGather(effectiveQuery, repoRef, tree, linkRefs, signal, pageContext?.markdown, onStatus)
        .catch(async e => { console.warn('[CTX] agentic failed, falling back to semantic:', e); return semanticEnrich(); });
    } else {
      onStatus?.('Reading relevant files & links…');
      enrich = await semanticEnrich();
    }

    for (const b of enrich.blocks) systemPrompt += b;
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
chatWebFallback
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
        }
      } catch (e) {
        if (signal.aborted) throw e;
        console.warn('[FORWARD-CHECK] failed', e);
      }
    }
  }

  onStatus?.('Writing the answer…');
  const branch: ChatBranch = grounded ? 'citation' : usePage ? 'page' : webSources.length ? 'web' : 'general';
  return { systemPrompt: rulesBlock + localeBlock + systemPrompt, formattedHistory, grounded, place, branch };
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
  const apiBase = ref.enterpriseHost
    ? `https://${ref.enterpriseHost}/api/v3`
    : 'https://api.github.com';
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (!branch) {
    const repoRes = await fetch(`${apiBase}/repos/${ref.owner}/${ref.repo}`, { headers });
    if (!repoRes.ok) return null;
    branch = (await repoRes.json()).default_branch as string;
  }
  const treeRes = await fetch(
    `${apiBase}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch!)}?recursive=1`,
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
      url = ref.enterpriseHost
        ? `https://${ref.enterpriseHost}/raw/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${encPath}`
        : `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${encPath}`;
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
    return s.pageContextStrategy === 'semantic' || s.pageContextStrategy === 'router' ? s.pageContextStrategy : 'agentic';
  } catch { return 'agentic'; }}

// ─────────────────────────────────────────────
// Chat routing mode — heuristic (default) or agentic
// ─────────────────────────────────────────────

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
  pageMarkdown?: string, onStatus?: (s: string) => void,
): Promise<{ blocks: string[]; sources: Array<{ title: string; url: string }> }> {
  const tools: ToolDef[] = [];
  const catalogFiles = tree && repoRef ? selectTreePaths(tree.paths.filter(p => !p.endsWith('/')), question, 6_000).selected : [];
  if (catalogFiles.length) {
    tools.push({ type: 'function', function: { name: 'read_file', description: 'Read the raw contents of one repository file by its exact path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } });
  }
  if (linkRefs.length) {
    tools.push({ type: 'function', function: { name: 'read_link', description: 'Fetch the readable content of one link found on the current page, by its exact URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } });
  }
  if (pageMarkdown) {
    tools.push(
      { type: 'function', function: { name: 'read_section', description: 'Read a specific section of the current page by its heading text. Use the section headings from the prompt to choose which to read.', parameters: { type: 'object', properties: { heading: { type: 'string', description: 'The exact heading text of the section to read' } }, required: ['heading'] } } },
      { type: 'function', function: { name: 'search_page', description: 'Search the ENTIRE page content (not just the head shown above) for a specific string — error message, function name, file path, exception type, etc. Returns matching lines with surrounding context. Like grep for the page. Use this to find errors, tracebacks, or specific patterns anywhere in the page.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for (case-insensitive substring match)' } }, required: ['query'] } } },
      { type: 'function', function: { name: 'read_lines', description: 'Read a range of lines from the current page by line number. Useful for reading traceback context around a known error line.', parameters: { type: 'object', properties: { startLine: { type: 'number', description: 'First line number (1-indexed)' }, count: { type: 'number', description: 'Number of lines to read (max 200)' } }, required: ['startLine', 'count'] } } },
    );
  }
  const webAllowed = await isChatWebFallbackEnabled();
  if (webAllowed) {
    tools.push({ type: 'function', function: { name: 'search_web', description: 'Run a live web search when the page and repo cannot answer.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } });
  }
  if (tools.length === 0) return { blocks: [], sources: [] };

  const catalogLinks = linkRefs.slice(0, 60);
  const isDebugPage = pageMarkdown ? looksLikeDebugPage(pageMarkdown) : false;
const sys = isDebugPage
  ? `You are a smart debugger reading a CI/test/error report page. ` +
    `Your job is to find the ROOT CAUSE: what failed, why, and what was expected. ` +
    `Use search_page to find the actual error message (search "Error:", "AssertionError", ` +
    `"FAIL", "expected", "received", "×", "✗"). Then use read_section or read_lines to ` +
    `read the traceback and surrounding context. Be thorough — a good debugger looks at ` +
    `the error, the traceback, the diff, and the context before concluding.\n`
  : `You are reading a web page to answer the user's question about it. ` +
    `Use the tools below to read the page content strategically as needed.\n` +
    (pageMarkdown
      ? `\nYou can read the page content in detail using read_section (by heading), search_page (grep), or read_lines (by line number). Start by searching for errors or reading the relevant section.\n`
      : '') +
    (catalogFiles.length ? `\nRepository files you may read:\n${catalogFiles.join('\n')}\n` : '') +
    (catalogLinks.length ? `\nPage links you may read:\n${catalogLinks.map(l => `${l.anchorText || l.url} — ${l.url}`).join('\n')}\n` : '');
  const messages: any[] = [{ role: 'system', content: sys }, { role: 'user', content: question }];

  const blocks: string[] = [];
  const sources: Array<{ title: string; url: string }> = [];
  let used = 0;
  const validPaths = new Set(catalogFiles);
  const linkByUrl = new Map(linkRefs.map(l => [l.url, l]));

  // Pre-compute page sections and lines for fast lookups
  const pageLines = pageMarkdown ? pageMarkdown.split('\n') : [];
  const pageHeadings: Array<{ heading: string; line: number }> = [];
  if (pageMarkdown) {
    const hRe = /^(#{1,4})\s+(.+)$/gm;
    let hm: RegExpExecArray | null;
    while ((hm = hRe.exec(pageMarkdown)) !== null) {
      const lineNum = pageMarkdown.slice(0, hm.index).split('\n').length;
      pageHeadings.push({ heading: hm[2].trim(), line: lineNum });
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await chatWithTools(messages, tools, signal);
    if (resp.toolCalls.length === 0) {
      if (round === 0 && blocks.length === 0) throw new Error('agentic: provider made no tool calls');
      break;
    }
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
        } else if (call.name === 'read_section' && pageMarkdown) {
          const heading = String(call.args?.heading || '').toLowerCase().trim();
          // Find the section by heading (fuzzy match)
          const match = pageHeadings.find(h => h.heading.toLowerCase().includes(heading) || heading.includes(h.heading.toLowerCase()));
          if (!match) {
            const available = pageHeadings.map(h => `"${h.heading}"`).join(', ');
            result = `Section "${heading}" not found. Available sections: ${available}`;
          } else {
            // Extract section content from heading to next heading or end
            const startLine = match.line - 1;
            let endLine = pageLines.length;
            const nextIdx = pageHeadings.indexOf(match) + 1;
            if (nextIdx < pageHeadings.length) endLine = pageHeadings[nextIdx].line - 1;
            const rawSection = pageLines.slice(startLine, endLine).join('\n');
            const truncated = rawSection.length > 8000;
            const sectionText = rawSection.slice(0, 8000);
            const block = `\n\n--- SECTION: ${match.heading} ---\n${sectionText}\n--- END SECTION ---\n` +
              (truncated ? `\n(Note: this section is ${rawSection.length} chars total. Only the first 8000 are shown. Use search_page or read_lines to explore further.)\n` : '');
            if (used + sectionText.length <= TOTAL_CTX_BUDGET) {
              blocks.push(block); used += sectionText.length;
              result = `read section "${match.heading}" (${sectionText.length} chars${truncated ? ` of ${rawSection.length}` : ''})`;
            } else result = 'context budget full';
          }
        } else if (call.name === 'search_page' && pageMarkdown) {
          const query = String(call.args?.query || '').toLowerCase();
          const CONTEXT = 3; // lines of context before/after
          const matches: string[] = [];
          const seen = new Set<string>();
          for (let i = 0; i < pageLines.length; i++) {
            if (pageLines[i].toLowerCase().includes(query)) {
              const start = Math.max(0, i - CONTEXT);
              const end = Math.min(pageLines.length, i + CONTEXT + 1);
              const key = `${start}-${end}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const snippet = pageLines.slice(start, end);
              snippet.unshift(`--- line ${start + 1} ---`);
              matches.push(snippet.join('\n'));
              if (matches.length > 10) { matches.push('… (more matches, refine your search)'); break; }
            }
          }
          if (matches.length === 0) result = 'no matches found';
          else {
            const text = `\n\n--- SEARCH: "${query}" ---\n${matches.join('\n\n')}\n--- END SEARCH ---\n`;
            if (used + text.length <= TOTAL_CTX_BUDGET) {
              blocks.push(text); used += text.length;
              result = `${matches.length} match(es) for "${query}"`;
            } else result = 'context budget full';
          }
        } else if (call.name === 'read_lines' && pageMarkdown) {
          const start = Math.max(0, (Number(call.args?.startLine) || 1) - 1);
          const count = Math.min(Number(call.args?.count) || 50, 200);
          const end = Math.min(pageLines.length, start + count);
          if (start >= pageLines.length) result = 'start line beyond page length';
          else {
            const snippet = pageLines.slice(start, end);
            snippet.unshift(`--- lines ${start + 1}-${end} ---`);
            const text = `\n\n--- LINES ${start + 1}-${end} ---\n${snippet.join('\n')}\n--- END LINES ---\n`;
            if (used + text.length <= TOTAL_CTX_BUDGET) {
              blocks.push(text); used += text.length;
              result = `read lines ${start + 1}-${end}`;
            } else result = 'context budget full';
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
      onStatus?.(result.length > 60 ? result.slice(0, 60) + '…' : result);
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
  const { apiKey, endpoint, model, isCopilot } = await getProviderSettings();
  if (!endpoint || !model) return [];

  const headers = buildProviderHeaders(apiKey, !!isCopilot);

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
- Keep the SAME language as the original query (do not translate to English)
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
async function callCompanion(companionUrl: string, args: Record<string, unknown>): Promise<any> {
  // Bounded: a hung companion (half-open socket, wedged CLI) used to stall the
  // chat turn until the browser's TCP timeout — minutes of apparent freeze.
  // Command execution passes its own timeoutMs; default 30s for health-ish calls.
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 30_000, 5_000), 300_000) + 5_000;
  // Shared-secret auth: a hardened companion (v1.2+) requires this Bearer token
  // before it will run a command. Omitted header = legacy/open companion still works.
  const { companionToken } = await chrome.storage.local.get(['companionToken']);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof companionToken === 'string' && companionToken) headers['Authorization'] = `Bearer ${companionToken}`;
  const res = await fetch(companionUrl, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: 'execute_command', arguments: args }
    })
  });
  if (res.status === 401) throw new Error('Companion rejected the token (401) — check the companion token in Settings matches the one the server was started with.');
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'JSON-RPC error');
  return data;
}

/** Does the running companion accept a `stdin` argument (v1.1+)? Old builds
 *  concatenate stderr into the answer and can't pipe a prompt — detect so we
 *  can degrade loudly instead of silently. */
async function companionSupportsStdin(companionUrl: string): Promise<boolean> {
  try {
    const healthUrl = companionUrl.replace(/\/mcp\/?$/, '/health').replace(/\/$/, '/health');
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.capabilities?.stdin === true;
  } catch {
    return false;
  }
}

async function resolveCliTemplate(cmdTemplate: string, companionUrl: string): Promise<string> {
  if (cmdTemplate !== 'auto') return cmdTemplate;
  try {
    const data = await callCompanion(companionUrl, { command: 'which claude || which agy || which copilot || which gh' });
    const path = data.result?.content?.[0]?.text || '';
    if (path.includes('claude')) return 'claude "{prompt}"';
    if (path.includes('agy')) return 'agy chat "{prompt}"';
    if (path.includes('copilot') || path.includes('gh')) return 'copilot explain "{prompt}"';
    throw new Error('No supported CLI found on PATH (claude, agy, copilot).');
  } catch (e: any) {
    throw new Error(`Auto CLI detection failed: ${e.message || String(e)}`);
  }
}

/**
 * One chat turn through the user's local CLI. Unlike the old path — which sent
 * ONLY the raw user message, so CLI-mode answers ignored the workspace sources,
 * the attached page, and the whole conversation — this pipes the SAME composed
 * context the standard provider gets.
 *
 * Untrusted context (page content, retrieved chunks) goes over STDIN, never
 * into the shell command string: interpolating it into `exec()` would be a
 * command-injection surface. When the companion is too old to pipe stdin, the
 * claude CLI falls back to argv with just the user's message (context lost) —
 * `onStatus` says so instead of failing silently.
 *
 * Throws when the CLI output is an error state (logged out, usage dump) so the
 * caller falls back to the standard provider instead of rendering
 * "Not logged in · Please run /login" as the assistant's answer.
 */
async function runCliChat(
  companionUrl: string,
  cmdTemplate: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  prompt: string,
  onStatus?: (s: string) => void,
): Promise<string> {
  const template = await resolveCliTemplate(cmdTemplate, companionUrl);
  const isClaude = /^\s*claude\b/.test(template);

  let command: string;
  let stdin: string | undefined;
  if (isClaude && await companionSupportsStdin(companionUrl)) {
    // Non-interactive print mode; the full composed turn rides stdin. `-p` with
    // a piped prompt also kills the "no stdin data received in 3s" probe wait.
    // Derived from the user's template (minus the {prompt} placeholder) so
    // configured flags like `--model opus` survive the stdin route.
    command = template.replace(/\s*"?\{prompt\}"?/, '').trim();
    if (!/(?:^|\s)(?:-p|--print)\b/.test(command)) command += ' -p';
    stdin = composeCliPrompt(systemPrompt, history, prompt);
  } else {
    if (isClaude) {
      // Old companion: no stdin channel. Keep it working, but say what's lost.
      onStatus?.('Companion server is outdated — restart it so CLI chat can see your sources.');
      command = template.includes('{prompt}') ? template : `${template.trim()} "{prompt}"`;
      if (!/\s(-p|--print)\b/.test(command)) command = command.replace(/^\s*claude\b/, 'claude -p');
    } else {
      command = template;
    }
    // argv carries ONLY the user's own message (short, and escaped) — never
    // page/source context, which is attacker-influenced.
    const escaped = prompt.replace(/[\\"`$]/g, '\\$&').replace(/\n/g, ' ');
    command = command.replace('{prompt}', escaped);
  }

  const data = await callCompanion(companionUrl, { command, stdin, timeoutMs: 240_000 });
  const raw = data.result?.content?.[0]?.text;
  if (raw === undefined) throw new Error('No output from CLI');
  const text = sanitizeCliOutput(raw);
  if (data.result?.isError) throw new Error((text || 'CLI command failed').slice(0, 300));
  if (isCliErrorOutput(text)) {
    throw new Error('Local CLI is not ready (not logged in or errored) — using the standard provider instead.');
  }
  return text;
}


async function handleChatRemoved(): Promise<Record<string, unknown>> {
  // CHAT_WITH_KNOWLEDGE was deleted: it duplicated the chat-stream port router
  // WITHOUT its refusal→web net, systemPromptOverride support, or streaming
  // disclosure laziness — any caller silently got a worse pipeline. Nothing in
  // the sidepanel called it (all chat flows use the `chat-stream` port).
  throw new Error('CHAT_WITH_KNOWLEDGE is removed — use the chat-stream port.');
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

    // Emit a token to the initiating port AND broadcast it so other sidepanel
    // instances of the same chat render the answer LIVE (not just spinner → final
    // reload). safePost feeds this port; the broadcast feeds every mirror.
    // Display a chunk to the initiating port + broadcast to mirrors, WITHOUT
    // touching `full` (used when we re-render already-accumulated text).
    let displayedAny = false;
    const display = (text: string) => {
      displayedAny = true;
      safePost({ type: 'DELTA', text });
      chrome.runtime.sendMessage({ action: 'CHAT_DELTA', chatId, text }).catch(() => {});
    };
    const resetDisplay = () => {
      safePost({ type: 'RESET' });
      chrome.runtime.sendMessage({ action: 'CHAT_RESET', chatId }).catch(() => {});
    };
    // Atomically REPLACE the rendered answer text (no clear-then-refill flicker,
    // no "empty bubble stuck streaming"). Used for post-stream corrections
    // (sentinel reconcile, stripping a model "Sources:" line).
    const replaceDisplay = (text: string) => {
      displayedAny = true;
      liveChatStreams.set(chatId, text);
      safePost({ type: 'REPLACE', text });
      chrome.runtime.sendMessage({ action: 'CHAT_REPLACE', chatId, text }).catch(() => {});
    };
    // Accumulate into `full` AND display.
    const emitDelta = (text: string) => {
      full += text;
      liveChatStreams.set(chatId, full);   // so a late-mounting panel can catch up
      display(text);
    };

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
      const built = await buildChatRequest(
        chatId, projectId, prompt, localController.signal, pageCtx,
        (text) => safePost({ type: 'STATUS', text })
      );
      const { formattedHistory, grounded, place, branch } = built;
      let systemPrompt = built.systemPrompt;

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

      // Tell OTHER sidepanel instances a question is in flight for this chat so
      // they mirror it live: `prompt` lets them show the question immediately,
      // then CHAT_DELTA broadcasts stream the answer, CHAT_STATE:false ends it.
      chrome.runtime.sendMessage({ action: 'CHAT_STATE', chatId, projectId, generating: true, prompt }).catch(() => {});

      // General-knowledge turns disclose themselves DETERMINISTICALLY — the old
      // prompt-side "begin with this italic line" instruction was routinely
      // skipped by small models, so users couldn't tell a sourced answer from a
      // from-memory one (the exact complaint behind "where did you find this?").
      // Emitted LAZILY on the first real token: emitting before the provider
      // call meant an immediate provider failure (401/429/…) persisted an
      // orphan assistant bubble containing only the disclosure line.
      let disclosed = branch !== 'general' || !!systemPromptOverride;
      // Sentinel guard: on a grounded (citation) turn the model may reply with
      // ONLY `NO_SOURCES_IN_WORKSPACE` to signal "not in the sources". That token
      // must NEVER reach the UI (users saw it flash before the web-escalation
      // replaced it). Hold display while the streamed text is still a prefix of
      // the sentinel; if real content diverges, flush the buffer; if it stays the
      // sentinel, it's handled after the stream (escalation / hygiene) and never
      // shown. `full` still accumulates so that logic can see it.
      const SENTINEL = 'NO_SOURCES_IN_WORKSPACE';
      let guardHolding = grounded;
      const emitAnswerDelta = (text: string) => {
        if (guardHolding) {
          full += text;
          const trimmed = full.replace(/^\s+/, '');
          if (trimmed.length === 0 || SENTINEL.startsWith(trimmed)) return; // still could be the sentinel — publish nothing
          guardHolding = false;
          liveChatStreams.set(chatId, full);
          display(full);            // diverged into real content → show what we buffered
          return;
        }
        if (!disclosed) {
          disclosed = true;
          emitDelta(`*No matching sources in this workspace — answering from general knowledge.*\n\n`);
        }
        emitDelta(text);
      };

      // Check if routing chat through CLI is enabled
      const storage = await chrome.storage.local.get(['routeChatThroughCli', 'cliCommandTemplate', 'localMcpCompanionUrl']);
      const routeChat = storage.routeChatThroughCli;
      // Same default as the UI ('auto' = detect an installed CLI) — the old
      // 'claude "{prompt}"' fallback made a fresh install behave differently
      // from what Settings displayed.
      const cmdTemplate = storage.cliCommandTemplate || CLI_TEMPLATE_AUTO;
      const companionUrl = storage.localMcpCompanionUrl || DEFAULT_COMPANION_MCP_URL;

      let useCli = false;
      if (routeChat === 'enabled' || routeChat === true) {
        useCli = true;
      } else if (routeChat === 'auto') {
        try {
          const healthUrl = companionUrl.replace(/\/mcp\/?$/, '/health');
          const probe = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(1000) });
          if (probe.ok) {
            useCli = true;
          }
        } catch {
          useCli = false;
        }
      }

      let cliSuccess = false;
      if (useCli) {
        safePost({ type: 'STATUS', text: 'Asking your local CLI…' });
        try {
          const outputText = await runCliChat(
            companionUrl, cmdTemplate, systemPrompt, formattedHistory, prompt,
            (text) => safePost({ type: 'STATUS', text }),
          );

          // Simulate streaming back word by word
          const words = outputText.split(/(\s+)/);
          for (const word of words) {
            if (localController.signal.aborted) break;
            emitAnswerDelta(word);
            await new Promise(r => setTimeout(r, 6));
          }
          cliSuccess = true;
        } catch (e: any) {
          safePost({ type: 'STATUS', text: `CLI failed: ${e.message || String(e)}. Falling back to standard LLM…` });
          await new Promise(r => setTimeout(r, 1200));
        }
      }

      if (!cliSuccess) {
        await chatWithCustomStream(systemPrompt, formattedHistory, prompt, localController.signal, emitAnswerDelta);
      }

      // RELIABLE NET: the score gate can still let a workspace-grounded turn
      // reach a refusal (reranker unavailable, or a keyword chunk that squeaks
      // over the bar). If the model itself says it can't answer from the
      // sources, escalate to a live web search and REPLACE the refusal — the
      // model's own judgment is the ground truth the scores only approximate.
      // Command turns (systemPromptOverride, e.g. /compare) get the net too —
      // a refusal there used to be FINAL, a dead end with no escalation.
      if (grounded && isRefusalAnswer(full) && await isChatWebFallbackEnabled()) {
        safePost({ type: 'STATUS', text: 'Not in your workspace — searching the web…' });
        // Localize the query (same as the main web branch) so "weather today"
        // resolves to the user's region, not the search provider's server IP.
        const netQuery = place && isLocationDependent(prompt) ? `${prompt} ${place}` : prompt;
        const web = await gatherWebSnippets(netQuery, {
          signal: localController.signal,
          onStatus: (text) => safePost({ type: 'STATUS', text }),
        }).catch(() => ({ context: '', sources: [] as Array<{ title: string; url: string }> }));

        if (web.context) {
          resetDisplay();   // clear the refusal from the panel + mirrors
          full = '';
          const webSys =
            (place ? `The user is in ${place}; answer for that location and do NOT ask them which city. ` : '') +
            `You are a friendly, knowledgeable assistant. The excerpts below are from a live web search run just now — treat them as your facts. ` +
            `Answer like a sharp, helpful friend: lead with the direct answer in natural, plain language, then just enough detail. ` +
            `Don't clutter the prose with [W#] tags — the sources are shown as links below. Use only what the excerpts support; if they don't answer it, say so plainly.` +
            LANGUAGE_RULE +
            `\n--- WEB RESULTS ---\n${web.context}\n--- END WEB RESULTS ---`;
          await chatWithCustomStream(webSys, [], prompt, localController.signal, emitDelta);
        }
      }

      // Sentinel hygiene: if the refusal net didn't fire (web fallback off, or
      // no web results), never leak the raw escalation token into the answer.
      if (full.includes('NO_SOURCES_IN_WORKSPACE')) {
        full = full.replace(/NO_SOURCES_IN_WORKSPACE/g, 'This information was not found in your sources.').trim();
      }

      // Reconcile the display with the final `full`. Needed when the sentinel
      // guard held the whole answer (so nothing was shown) and no web escalation
      // replaced it: render the cleaned text now instead of an empty bubble.
      if (full.trim() && !displayedAny) {
        replaceDisplay(full);
      }

      // Deterministic clickable trail of auto-followed links — streamed as a
      // final delta so it renders live AND lands in the saved message.
      // The footer lists WEB pages (web-search results / followed links). It is
      // OFF by default: users want "Sources" to mean their saved library, not
      // weather sites. Library-doc citations render separately as [n] chips.
      // ALWAYS remove any "Sources:" line the MODEL wrote — our footer (added
      // below only when enabled) is the single authoritative one. This is what
      // was still leaking "Sources: lushbinary.com · zylos.ai" into answers.
      const cleaned = stripAnySourcesFooter(full);
      if (cleaned !== full && full.trim()) {
        full = cleaned;
        replaceDisplay(full);   // atomic swap — no clear-then-refill flicker
      }


      if (full.trim()) {
        const { model: usedModel } = await getProviderSettings();
        await saveChatMessage({
          chatId,
          role: 'assistant',
          text: full,
          timestamp: new Date().toISOString(),
          provider: usedModel || 'custom'
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
        const errText = String(err instanceof Error ? err.message : err);
        // PERSIST the failure. The panel's ERROR handler only appends the
        // message to React state — and the CHAT_STATE:false broadcast below
        // triggers loadChatHistory, which replaces state with the saved
        // history and WIPED the unpersisted error (observed live: a 401
        // flashed and vanished, leaving a silent dead turn). Saving it as a
        // system message survives the reconcile and mirrors to other windows.
        await saveChatMessage({
          chatId, role: 'system',
          text: `⚠️ ${errText}`,
          timestamp: new Date().toISOString(), provider: 'custom'
        }).catch(() => {});
        safePost({ type: 'ERROR', error: errText });
      }
    } finally {
      interactiveDepth = Math.max(0, interactiveDepth - 1);
      clearInterval(keepAlive);
      if (abortControllers.get(chatId) === localController) abortControllers.delete(chatId);
      liveChatStreams.delete(chatId);
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
    `Today's date is ${new Date().toISOString().slice(0, 10)}. You rewrite a user's research request into ONE self-contained, web-searchable research topic. The request may reference the conversation or the user's workspace documents ("these", "this model", "the above"). Resolve those references using the provided context. Return ONLY the rewritten topic as a single sentence — no quotes, no explanation, and KEEP the language of the original request. If the request is already self-contained, return it unchanged.`,
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

  // Resolve conversational references into a standalone topic
  let effectiveTopic = topic as string;
  try {
    const topicSignal = AbortSignal.timeout(15000);
    const chatFn = (s: string, u: string) => chatWithCustom(s, [], u, topicSignal);
    effectiveTopic = await resolveResearchTopic(topic as string, chatId as string | undefined, projectId as string, chatFn);
  } catch {
    // fallback to raw topic
  }

  // Generate research directives for user review
  let subQuestions: string[] = [];
  try {
    const planSignal = AbortSignal.timeout(15000);
    const chatFn = (s: string, u: string) => chatWithCustom(s, [], u, planSignal);
    subQuestions = await generateSubQuestions(effectiveTopic, chatFn);
  } catch {
    // fallback
  }

  // Shape of the run, so the plan card can show the pipeline + a time
  // expectation: quick = one gather pass; deep = N staged rounds by depth.
  const limits = await getResearchLimits();
  const mode = (request.mode as string) === 'deep' ? 'deep' : 'quick';
  // /academic runs the full staged deep pipeline over a papers-only corpus.
  const sourceMode = (request.sourceMode as string) === 'academic' ? 'academic' : 'auto';
  const isStaged = mode === 'deep' || sourceMode === 'academic';
  const stages = isStaged ? limits.rounds : 1;
  const estMinutes = isStaged ? Math.max(8, stages * 6) : 4;

  return { effectiveTopic, subQuestions, stages, estMinutes, sourceMode };
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
  const BUILTINS = builtinCommandNames();
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

/** Is a research run genuinely active right now? Reclaims a stale (dead-heartbeat)
 *  job so the queue can't wedge forever behind a worker that was killed. */
async function isResearchActive(): Promise<boolean> {
  const job = await getResearchJob().catch(() => null) as any;
  if (!job?.active) return false;
  const fresh = job.lastHeartbeatAt && (Date.now() - job.lastHeartbeatAt) < HEARTBEAT_STALE_MS;
  if (fresh) return true;
  console.warn('[RESEARCH] Reclaiming stale active job (heartbeat dead)');
  await clearResearchJob().catch(() => {});
  return false;
}

/** Resolve the topic, checkpoint + mark the job active, and run it. Shared by the
 *  direct-start path and the queue drainer. */
async function startResearchRun(params: { projectId: string; chatId?: string; topic: string; mode: 'quick' | 'deep'; sourceMode?: 'auto' | 'academic'; preResolved?: boolean }): Promise<Record<string, unknown>> {
  const { projectId, chatId, topic, mode, sourceMode = 'auto', preResolved } = params;
  researchStartsPending.add(projectId);
  try {
    const chatFn = (s: string, u: string) => chatWithCustom(s, [], u);
    // A topic that already went through resolveResearchTopic at PREVIEW time
    // (and was confirmed on the plan card) must run AS SHOWN — re-resolving
    // against possibly-updated history made the executed run diverge from the
    // confirmed plan (and cost a second LLM call).
    let effectiveTopic = topic;
    if (!preResolved) {
      try {
        effectiveTopic = await resolveResearchTopic(topic, chatId, projectId, chatFn);
      } catch (e) {
        console.warn('Topic resolution failed, using raw topic', e);
      }
    }
    // Checkpoint so a worker/browser death can resume it; mark active BEFORE running
    // so resumePendingResearch only resumes jobs that actually started.
    await startResearchJob({ projectId, chatId, topic, effectiveTopic, mode, sourceMode }).catch(() => {});
    await markJobActive().catch(() => {});
    return await executeResearch({ projectId, chatId, topic, effectiveTopic, mode, sourceMode });
  } finally {
    researchStartsPending.delete(projectId);
  }
}

// One research run at a time (the job checkpoint is a singleton). Rather than
// erroring on a second /deepresearch, PARK it in a persisted queue and drain it
// as each run finishes. `queueDraining` serializes the drainer so two starts can't
// race for the single job slot.
let queueDraining = false;
async function drainResearchQueue(): Promise<void> {
  if (queueDraining) return;
  queueDraining = true;
  try {
    // Only RESEARCH controllers count as busy — a chat stream must never park
    // the research queue (chat during a run is a supported flow).
    if (researchControllers.size > 0 || researchStartsPending.size > 0 || await isResearchActive()) return; // still busy
    const next = await dequeueResearch();
    if (!next) return;
    chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_LOG', projectId: next.projectId, status: '[QUEUE] Starting next queued research…' }).catch(() => {});
    await startResearchRun(next); // runs to completion; its finally re-schedules a drain
  } catch (e) {
    console.warn('[QUEUE] drain failed', e);
  } finally {
    queueDraining = false;
  }
}
function scheduleQueueDrain(): void { setTimeout(() => { void drainResearchQueue(); }, 0); }

async function handleDeepResearch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { projectId, topic, chatId } = request;
  const mode = (request.mode as 'quick' | 'deep') || 'quick';
  const sourceMode = (request.sourceMode as string) === 'academic' ? 'academic' as const : 'auto' as const;
  if (!projectId || !topic) throw new Error('projectId and topic are required');

  // Claim the start slot SYNCHRONOUSLY (before any await). Two rapid
  // START_DEEP_RESEARCH messages otherwise both pass the async busy check below
  // (the first is still awaiting resolveResearchTopic) and run concurrently,
  // stomping the singleton job checkpoint.
  const pid = projectId as string;
  const claimed = !researchStartsPending.has(pid) && !researchControllers.has(pid);
  if (claimed) researchStartsPending.add(pid);

  // Persist the command in chat first so it shows in the conversation whether it
  // starts now or gets queued.
  if (chatId) {
    const cmd = sourceMode === 'academic' ? '/academic' : mode === 'deep' ? '/deepresearch' : '/research';
    await saveChatMessage({
      chatId: chatId as string,
      role: 'user',
      text: `${cmd} ${topic}`,
      timestamp: new Date().toISOString(),
      provider: 'custom'
    });
  }

  // If a run is already active, queue this one instead of erroring — it starts
  // automatically when the current run finishes.
  const busy = !claimed || researchControllers.has(pid) || await isResearchActive();
  if (busy) {
    if (claimed) researchStartsPending.delete(pid);
    const position = await enqueueResearch({
      projectId: projectId as string,
      chatId: chatId as string | undefined,
      topic: topic as string,
      mode,
      sourceMode,
      preResolved: request.preResolved === true
    });
    if (chatId) {
      await saveChatMessage({
        chatId: chatId as string,
        role: 'system',
        text: `🕓 Queued (position ${position}) — this research will start automatically when the current run finishes.`,
        timestamp: new Date().toISOString(),
        provider: 'custom'
      }).catch(() => {});
    }
    chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_QUEUED', projectId, position }).catch(() => {});
    return { success: true, queued: true, position };
  }

  return startResearchRun({
    projectId: projectId as string,
    chatId: chatId as string | undefined,
    topic: topic as string,
    mode,
    sourceMode,
    preResolved: request.preResolved === true
  });
}

interface ResearchParams {
  projectId: string;
  chatId?: string;
  topic: string;
  effectiveTopic: string;
  mode: 'quick' | 'deep';
  sourceMode?: 'auto' | 'academic';
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
// Hard deadline for intermediate LLM calls (intent resolution, routing, page
// relevance). Prevents "Understanding the question…" from hanging forever when
// the provider is unresponsive. Falls back gracefully on timeout.
const INTENT_LLM_TIMEOUT_MS = 15_000;
// Max conversation turns fed into the context window. Long chats balloon the
// prompt (each message ~200+ tokens) → slow TTFT. A 16-turn window preserves
// recent context while keeping prefill under ~3K tokens.
const MAX_HISTORY_TURNS = 16;

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

/**
 * Race a promise against a hard timeout. If the promise wins, clear the timer;
 * if the timeout fires first, reject with a descriptive error. The inner promise
 * keeps running (we don't abort it) — we just stop waiting so the caller can
 * fall back to its error path. Used on intermediate LLM calls that must not
 * block the pipeline indefinitely.
 */
async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run (or resume) a research job. Job checkpoint must already exist. */
async function executeResearch({ projectId, chatId, topic, effectiveTopic, mode, sourceMode = 'auto' }: ResearchParams): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  researchControllers.set(projectId, controller);
  const signal = controller.signal;
  const researchModel = (await getProviderSettings().catch(() => ({ model: '' }))).model || 'custom';

  // Workspace instructions apply to research too — prepended to every research
  // LLM call's system prompt so the report follows the workspace's conventions.
  const rp = await getProject(projectId).catch(() => null);
  const languageBlock =
    `--- REPORT LANGUAGE ---\n` +
    `The research topic is: "${effectiveTopic.slice(0, 300)}".\n` +
    `Write the ENTIRE report — headings, body, tables, and verdict — in the SAME language as that topic.\n` +
    `If the topic is clearly in English, output strictly in English. Never switch language mid-report.\n` +
    `--- END REPORT LANGUAGE ---\n\n`;
  const workspaceBlock = rp?.rules?.trim()
    ? `--- WORKSPACE INSTRUCTIONS (always follow these) ---\n${rp.rules.trim()}\n--- END WORKSPACE INSTRUCTIONS ---\n\n`
    : '';
  // Language first: it is a higher-level constraint than workspace style rules.
  const researchRules = languageBlock + workspaceBlock;

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
    crumb('research', status.slice(0, 200));  // persists — the last one before a crash survives
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

  // Unconditional progress heartbeat — nudges lastProgressAt every 30s so the
  // watchdog never fires on a healthy-but-slow run. The phase-specific heartbeats
  // (withKeepAlive wrappers) are the primary defense; this is the safety net.
  const keepAliveInterval = setInterval(() => {
    lastProgressAt = Date.now();
  }, 30_000);

  const heartbeatInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo?.().catch(() => {});
    updateHeartbeat().catch(() => {});
    // SW uptime at each beat — the last one before a restart tells us whether the
    // worker dies at a consistent age (Chrome's hard MV3 lifetime cap) vs a
    // variable point (memory). The SW process has no memory API, so this is the
    // decisive SW-side signal.
    crumb('sw', 'heartbeat', { upSec: Math.round((Date.now() - SW_BOOT_AT) / 1000) });

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
    const result = await runDeepResearch(projectId, effectiveTopic, chatFn, onProgress, signal, mode, synthesisFn, undefined, sourceMode);

    // Persist the synthesis as an assistant message — this is what keeps
    // the chat session intact after research finishes.
    if (chatId) {
      const interpretedNote = effectiveTopic !== topic ? `*Interpreted as: "${effectiveTopic}"*\n\n` : '';
      // Truncate the heading topic to keep the report title readable
      const headingTopic = topic.length > 120 ? topic.slice(0, 117) + '…' : topic;
      await saveChatMessage({
        chatId,
        role: 'assistant',
        text: `## ${sourceMode === 'academic' ? 'Academic Research' : 'Deep Research'}: ${headingTopic}\n\n${interpretedNote}${result.synthesis}`,
        timestamp: new Date().toISOString(),
        provider: researchModel
      });
    }

    // Mark finished before clearing — if clearJob's storage write loses a race
    // with a worker death, the active:false flag prevents a spurious auto-resume.
    await markJobFinished().catch(() => {});
    await clearResearchJob().catch(() => {});
    return { success: true, synthesis: result.synthesis, sources: result.sources };
  } catch (err: any) {
    let message = err.message;
    if (err.message === 'AbortError') {
      // Distinguish user stop, watchdog, and other abort reasons so the UI
      // doesn't label every abort as a user cancellation.
      const reason = controller.signal.reason as any;
      if (reason?.message === 'watchdog') {
        message = 'Research stalled — no progress for 8 minutes.';
      } else if (reason?.name === 'AbortError' || /aborted/i.test(reason?.message || '')) {
        message = 'Cancelled';
      } else {
        message = reason?.message || 'Cancelled';
      }
    }
    if (message !== 'Cancelled') {
      console.error('[executeResearch] failure', message, err.stack);
    }
    doneError = message;
    if (chatId) {
      await saveChatMessage({
        chatId,
        role: 'system',
        text: message === 'Cancelled' ? 'Research cancelled.' : `Deep research failed: ${message}`,
        timestamp: new Date().toISOString(),
        provider: 'custom'
      }).catch(() => {});
    }
    // Handled failure/cancel — do not auto-retry on next startup
    await markJobFinished().catch(() => {});
    await clearResearchJob().catch(() => {});
    return { success: false, error: message };
  } finally {
    clearInterval(keepAliveInterval);
    clearInterval(heartbeatInterval);
    researchControllers.delete(projectId);
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
    // This run is done + the job cleared — start the next queued research, if any.
    scheduleQueueDrain();
    // Auto sync to Drive in the background
    handleSyncToDrive().catch(() => {});
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

    // NOTE: we deliberately do NOT clear on a "fresh heartbeat" anymore. The
    // finish path calls markJobFinished() (active:false) BEFORE clearJob(), so a
    // job that restarts still marked active:true can ONLY mean it died mid-run —
    // never "just finished". Chrome's ~5-minute MV3 worker lifetime cap kills
    // long research runs while the heartbeat is still fresh (updated ≤20s before
    // the kill); the old fresh-heartbeat clear then threw the whole run away
    // instead of resuming it. An active job = resume; the attempt cap below bounds
    // any genuine loop.

    if (researchControllers.has(job.projectId) || researchStartsPending.has(job.projectId)) return; // already running in this instance
    if (Date.now() - new Date(job.startedAt).getTime() > JOB_MAX_AGE_MS) {
      await clearResearchJob();
      return;
    }

    // Resume attempt cap. Chrome's ~5-min MV3 worker lifetime means a full deep
    // run (multiple stages, each near the cap) legitimately needs several resumes
    // to finish — each one makes forward progress (completed stages are skipped,
    // scraped pages are cached, embedded chunks dedup). So the cap is generous;
    // it exists only to stop a genuinely wedged job from looping forever.
    const attemptCount = await incrementResumeAttempts();
    if (attemptCount > 12) {
      const message = `Research stopped: the run was interrupted too many times to finish (Chrome recycles the extension's background worker roughly every 5 minutes, and this run needed more segments than that allows). Try a lower research depth, or split the topic into narrower queries.`;
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
      mode: job.mode,
      sourceMode: job.sourceMode
    });
  } catch (e) {
    console.warn('Research resume failed', e);
  } finally {
    // On startup, if nothing resumed/started, kick off any queued research. (A run
    // that DID resume self-drains from its own finally; drainResearchQueue no-ops
    // while that's still busy, so this is harmless in that case.)
    scheduleQueueDrain();
  }
}
// Give the worker a moment to settle, then check for an interrupted job.
setTimeout(() => { void resumePendingResearch(); }, 2000);

// ── Embedding-model migration ──
// The embedder was swapped to multilingual-e5-small; embeddings from the old
// English MiniLM are cosine-incompatible (stored vectors would match NOTHING
// against new query vectors). Detect the swap once and re-index the library in
// the background. Chunks stay keyword-searchable meanwhile.
const EMBED_MODEL_STORAGE_KEY = 'magpie-embedding-model';
const CURRENT_EMBED_MODEL = 'multilingual-e5-small';
setTimeout(() => {
  (async () => {
    try {
      const s = await chrome.storage.local.get([EMBED_MODEL_STORAGE_KEY]);
      if (s[EMBED_MODEL_STORAGE_KEY] === CURRENT_EMBED_MODEL) return;
      const docs = await listDocuments();
      await chrome.storage.local.set({ [EMBED_MODEL_STORAGE_KEY]: CURRENT_EMBED_MODEL });
      if (docs.length === 0) return;
      crumb('sw', 'embedding model changed — background re-index', { docs: docs.length });
      chrome.runtime.sendMessage({ action: 'DEEP_RESEARCH_LOG', status: '[INDEX] Upgrading the search index for multilingual support… (one-time, runs in background)' }).catch(() => {});
      await handleReindexLibrary();
    } catch (e) {
      console.warn('[SW] embedding-model migration check failed', e);
    }
  })();
}, 8000);

// ─────────────────────────────────────────────
// AI Provider Implementations
// ─────────────────────────────────────────────


// ── Provider Settings Helper ──

// ── Image blob helpers (docImages store) ──
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!m) throw new Error('bad data URL');
  const mime = m[1] || 'image/png';
  if (m[2]) {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(m[3])], { type: mime });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

// ── Jina Reader: free web/PDF → markdown (no API key) ──
// Central guard: the jinaReaderEnabled privacy toggle must hold on EVERY path
// (page context, PDF capture fallback, deep research) — previously only the
// deep-researcher checked it, so URLs leaked to r.jina.ai with the toggle OFF.
async function fetchViaJina(url: string): Promise<string> {
  const s = await chrome.storage.local.get(['jinaReaderEnabled']);
  if (s.jinaReaderEnabled === false) throw new Error('Jina Reader disabled in Settings');
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
  const { apiKey, endpoint, visionModel, model, isCopilot } = await getProviderSettings();
  if (!endpoint) throw new Error('Set an API Base URL in Settings first.');
  // trim(): a whitespace-only visionModel ("Use Text Model" sentinel bug) is
  // truthy and would be sent as a literal " " model name — treat it as unset.
  const useModel = (visionModel?.trim()) || model;
  if (!useModel) throw new Error('Set a Vision Model in Settings first.');

  const headers = buildProviderHeaders(apiKey, !!isCopilot);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    // A stalled vision endpoint must not hang image import / PDF OCR forever —
    // these run fire-and-forget with no watchdog of their own.
    signal: AbortSignal.timeout(120_000),
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

async function handleSyncToDrive(request?: Record<string, unknown>): Promise<Record<string, unknown>> {
  // interactive=true when user clicks "Force Sync" in settings — triggers
  // the Google sign-in popup if the token expired. Background auto-syncs use
  // interactive=false (silent, no popup).
  const interactive = !!(request?.interactive);
  const token = await getToken(interactive);
  const magpieFolderId = await ensureFolder(token);
  const unsynced = await getUnsyncedDocuments();

  // Fetch all projects so we can sort docs into project subfolders.
  const projects = await listProjects();
  const projectMap = new Map(projects.map(p => [p.id, p.title]));
  // Cache subfolder IDs per project to avoid redundant Drive API calls.
  const subfolderCache = new Map<string, string>();

  let synced = 0;
  const errors: string[] = [];

  for (const doc of unsynced) {
    try {
      const fileName = doc.title.replace(/[/\\?%*:|"<>]+/g, '-').substring(0, 120) + '.md';

      // Determine the target folder: project subfolder when the doc belongs
      // to a named project, otherwise the root Magpie folder.
      let targetFolderId = magpieFolderId;
      if (doc.projectId) {
        const projectName = projectMap.get(doc.projectId);
        if (projectName && projectName !== 'Default Session') {
          let subId = subfolderCache.get(doc.projectId);
          if (!subId) {
            subId = await ensureSubfolder(token, magpieFolderId, sanitizeSegment(projectName));
            subfolderCache.set(doc.projectId, subId);
          }
          targetFolderId = subId;
        }
      }

      const driveFileId = await uploadMarkdown(token, targetFolderId, fileName, doc.content);
      await updateDocumentSync(doc.id, true, driveFileId);
      synced++;
    } catch (err) {
      errors.push(`${doc.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { synced, total: unsynced.length, errors };
}

/**
 * Ensure a subfolder exists inside a parent folder. Uses the Drive API to
 * create it if missing. Cached lookup by name within the parent.
 */
async function ensureSubfolder(token: string, parentId: string, name: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const searchRes = await driveRequest(`/drive/v3/files?q=${q}&fields=files(id)`, token);
  const searchData = await searchRes.json();
  if (searchData.files?.length > 0) return searchData.files[0].id;

  const createRes = await driveRequest('/drive/v3/files', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const createData = await createRes.json();
  return createData.id;
}

/** Keep one path segment (folder or filename stem) safe across OSes and Drive. */
function sanitizeSegment(name: string): string {
  return (name || '')
    .replace(/[/\\?%*:|"<>]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .substring(0, 120)
    .trim() || 'untitled';
}

async function handleImportFromDrive(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await getToken(false);
  const rootFolderId = await ensureFolder(token);
  const projectId = request.projectId as string;
  if (!projectId) throw new Error('projectId is required for importing');

  // Collect files from the root folder and all subfolders recursively.
  const allFiles: Array<{ id: string; name: string; createdTime: string }> = [];
  const foldersToScan = [rootFolderId];
  const seen = new Set<string>();

  while (foldersToScan.length > 0) {
    const parentId = foldersToScan.pop()!;
    if (seen.has(parentId)) continue;
    seen.add(parentId);

    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const res = await driveRequest(
      `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,createdTime,parents)&orderBy=createdTime desc&pageSize=100`,
      token
    );
    const data = await res.json();
    for (const f of (data.files || [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        foldersToScan.push(f.id);
      } else if (f.name?.endsWith('.md')) {
        allFiles.push({ id: f.id, name: f.name, createdTime: f.createdTime });
      }
    }
  }

  let imported = 0;

  for (const file of allFiles) {
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

  return { imported, total: allFiles.length };
}

async function handleListDriveFiles(): Promise<Record<string, unknown>> {
  const token = await getToken(false);
  const storage = await chrome.storage.local.get(['driveFolderId']);
  if (!storage.driveFolderId) return { files: [] };

  // Recursively list files from the root folder and all subfolders.
  const allFiles: any[] = [];
  const foldersToScan = [storage.driveFolderId];
  const seen = new Set<string>();

  while (foldersToScan.length > 0) {
    const parentId = foldersToScan.pop()!;
    if (seen.has(parentId)) continue;
    seen.add(parentId);

    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const res = await driveRequest(
      `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,createdTime,parents)&orderBy=createdTime desc&pageSize=100`,
      token
    );
    const data = await res.json();
    for (const f of (data.files || [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // Only descend into folders that look like project root folders
        // (not hidden, not empty name).
        if (f.name && !f.name.startsWith('.')) {
          foldersToScan.push(f.id);
        }
      } else {
        allFiles.push(f);
      }
    }
  }

  return { files: allFiles };
}
