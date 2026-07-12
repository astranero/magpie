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
  /** Render markdown even WHILE streaming (research report). Its deltas are
   *  coalesced upstream, so live markdown parsing stays cheap — and the report
   *  arrives formatted instead of as a wall of raw markdown. */
  renderLive?: boolean;
  /** Research plan card — rendered instead of the text body when present. */
  plan?: ResearchPlan;
}

/**
 * In-chat research plan. Lives in UI state only (never persisted): the chat
 * history keeps the /research command and the final report; the plan card is
 * the interactive negotiation in between. While status is 'draft', normal
 * chat input refines the plan instead of starting a chat turn.
 */
export interface ResearchPlan {
  topic: string;
  effectiveTopic: string;
  subQuestions: string[];
  mode: 'quick' | 'deep';
  status: 'loading' | 'draft' | 'refining' | 'started' | 'cancelled';
  /** Gather rounds this run will make (1 = quick single pass). */
  stages?: number;
  /** Rough end-to-end expectation shown on the card. */
  estMinutes?: number;
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
