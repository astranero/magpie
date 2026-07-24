import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installCrashHandlers, crumb } from '../lib/crash-log';
import { THEME_STORAGE_KEY, THEME_CHANGED_EVENT, readThemePref, resolveTheme } from '../lib/theme';
import '../i18n'; // Initialize i18n before rendering

// The sidepanel shares a renderer process with the offscreen doc and can crash on
// its own (OOM while rendering a huge report, or an uncaught error). It had NO
// crash instrumentation, so those crashes left no trail. Capture uncaught errors +
// rejections, and breadcrumb the panel's own JS heap every 5 s — an OOM kills the
// tab with no JS error, so the last heap value before the gap is the only signal.
installCrashHandlers('sidepanel');
setInterval(() => {
  try {
    const m = (performance as any).memory;
    if (m) crumb('sidepanel', 'mem', { heapMB: Math.round(m.usedJSHeapSize / 1048576), limMB: Math.round(m.jsHeapSizeLimit / 1048576) });
  } catch { /* no performance.memory */ }
}, 5000);

// Respond to SW queries: heap report + health check.
// The SW uses GET_HEAP to monitor combined renderer memory and
// SIDEPANEL_HEALTH_CHECK to detect if the renderer process was killed.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'GET_HEAP') {
    try {
      const m = (performance as any).memory;
      sendResponse({ heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : 0 });
    } catch { sendResponse({ heapMB: 0 }); }
    return true;
  }
  if (msg.action === 'SIDEPANEL_HEALTH_CHECK') {
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Theme: follows the OS by default; the Theme setting (Settings → Appearance)
// overrides with an explicit choice. Toggles the class the design tokens are
// keyed on (previously the theme was dead code — nothing ever applied it).
//
// 'village' is a third palette, not a light/dark axis: it is a light theme, so
// choosing it turns .dark off. The two classes are mutually exclusive.
function applyThemePref(): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* private mode */ }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const { dark, village } = resolveTheme(readThemePref(raw), prefersDark);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('village', village);
}
applyThemePref();
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemePref);
  window.addEventListener(THEME_CHANGED_EVENT, applyThemePref);
} catch { /* older Chrome — no live switching */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
