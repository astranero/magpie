import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installCrashHandlers, crumb } from '../lib/crash-log';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
