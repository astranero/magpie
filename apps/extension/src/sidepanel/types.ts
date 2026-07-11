export interface LocalDocument {
  id: string;
  title: string;
  url: string;
  capturedAt: string;
  favicon?: string;
  wordCount: number;
  syncedToDrive: boolean;
  enabled?: boolean;
  content?: string;
  bibtex?: string;
}

export interface Project {
  id: string;
  title: string;
  documentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  provider?: string;
  /** True while the assistant message is being streamed. Render as plain
   *  text mid-stream; swap to full markdown when DONE flips this to false. */
  streaming?: boolean;
}

export interface ResolvedCitation {
  anchorId: string;
  docId: string;
  docTitle: string;
  docUrl: string;
  chunkText: string;
  sectionPath: string;
  heading: string;
}

export interface TabInfo {
  title: string;
  url: string;
  favIconUrl?: string;
}

export type View = 'lore' | 'chat' | 'settings' | 'document';
