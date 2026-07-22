import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * Patch the Vite modulepreload polyfill in the service worker bundle.
 * The polyfill references `document` and `window` which don't exist
 * in service workers, causing "window is not defined" crashes.
 */
function patchServiceWorkerPolyfill(): Plugin {
  return {
    name: 'patch-sw-polyfill',
    renderChunk(code, chunk) {
      if (chunk.fileName === 'background.js') {
        // Replace `window.dispatchEvent(...)` with `self.dispatchEvent(...)`
        code = code.replace(/\bwindow\.dispatchEvent\b/g, 'self.dispatchEvent');
        // Guard `document` references in the polyfill (they're in an IIFE that
        // checks `typeof document` first, but the outer const still evaluates)
        code = code.replace(
          /typeof document<"u"&&document\.createElement\("link"\)\.relList/g,
          'typeof document!="undefined"&&document.createElement("link").relList'
        );
        return { code, map: null };
      }
      return null;
    }
  };
}

// Main build: HTML entries (sidepanel, offscreen) + module service worker.
// Content scripts (content.js, inject.js) are built by vite.content.config.ts
// as self-contained IIFE bundles, because content scripts cannot use ES module
// imports — sharing chunks with these entries would break them.
export default defineConfig({
  plugins: [
    react(),
    patchServiceWorkerPolyfill(),
    viteStaticCopy({
      targets: [
        {
          src: 'src/manifest.json',
          dest: '.',
          rename: { stripBase: 1 }
        },
        {
          src: 'src/icons/**/*',
          dest: 'icons',
          rename: { stripBase: 2 }
        },
        {
          src: '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*',
          dest: 'transformers'
        }
      ]
    })
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  build: {
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        offscreen: resolve(__dirname, 'offscreen.html'),
        background: resolve(__dirname, 'src/background/service-worker.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
});
