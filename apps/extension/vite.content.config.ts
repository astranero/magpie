import { defineConfig } from 'vite';
import { resolve } from 'path';

// Second build pass: content scripts as self-contained bundles.
// Content scripts run in the page context and cannot use ES module imports,
// so each entry is built separately with everything inlined. Output stays
// 'es' format (no import/export emitted for a single self-contained entry):
// - content.js must be a classic-script-compatible bundle
// - inject.js must remain a bare IIFE expression whose completion value is
//   returned by chrome.scripting.executeScript (wrapping it breaks YouTube
//   transcript capture)
const entry = process.env.CONTENT_ENTRY || 'content';

const entries: Record<string, { input: string; fileName: string }> = {
  content: { input: 'src/content/content.ts', fileName: 'content.js' },
  inject: { input: 'src/content/inject.ts', fileName: 'inject.js' }
};

const target = entries[entry];

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, target.input),
      output: {
        format: 'es',
        entryFileNames: target.fileName,
        inlineDynamicImports: true
      }
    }
  }
});
