/// <reference types="vite/client" />

// Vite `?url` asset imports (e.g. the pdf.js worker bundled as a URL).
declare module '*?url' {
  const url: string;
  export default url;
}

/** Injected at build time by vite.config.ts — see the BUILD_STAMP note there. */
declare const __BUILD_STAMP__: string;
