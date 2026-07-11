/// <reference types="vite/client" />

// Vite `?url` asset imports (e.g. the pdf.js worker bundled as a URL).
declare module '*?url' {
  const url: string;
  export default url;
}
