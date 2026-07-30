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
  /** Persistent per-workspace instructions injected into every chat/research. */
  rules?: string;
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
  /** A user message waiting in the queue behind an active research run —
   *  shown with a "Queued" badge until the run finishes and it executes. */
  queued?: boolean;
  /** Marks a system message as a failed turn: the raw error string. The view
   *  runs it through diagnoseError to show a recovery block instead of a bare
   *  line. Set both from the live ERROR event and, on load, from the "⚠️ "-
   *  prefixed system message the worker persists so the failure survives the
   *  history reconcile. */
  error?: string;
  /** Images on this turn as data URLs: the user's attachment or images the
   *  model generated. Rendered as thumbnails under the bubble. */
  images?: string[];
  /** Interactive quiz for a /teach lesson — rendered as a card under the text.
   *  UI state only (per-question answers/verdicts live here). */
  quiz?: QuizQuestion[];
  /** A /flashcard deck — the message shows an "Open deck" button that launches
   *  the full-panel player. */
  deck?: Flashcard[];
  /** Title for the deck (shown in the player header + open button). */
  deckTitle?: string;
  /** Command buttons under a message, e.g. "Continue → next lesson" (/teach). */
  actions?: { label: string; command: string }[];
  /** Workspace documents used for grounding this turn. */
  sources?: Array<{ docId: string; docTitle: string; url?: string }>;
}

/** One flashcard: a recall cue and its answer. */
export interface Flashcard {
  front: string;
  back: string;
  hint?: string;
}

/**
 * One interactive quiz question under a lesson. `mcq` is checked locally; `open`
 * is graded by the LLM. The `ui*` fields are per-question local state, mutated
 * as the learner answers — the quiz is never persisted, like ResearchPlan.
 */
export interface QuizQuestion {
  type: 'mcq' | 'open';
  prompt: string;
  options?: string[];
  answerIndex?: number;
  modelAnswer?: string;
  explanation?: string;
  /** Local state ↓ */
  uiAnswer?: string;                 // open: typed text / mcq: selected option index as string
  uiVerdict?: 'correct' | 'partial' | 'incorrect' | 'revealed';
  uiFeedback?: string;               // grader's one-liner (open)
  uiGrading?: boolean;               // open: awaiting the grade call
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
  /** 'academic' = papers-only corpus (/academic). Absent = 'auto'. */
  sourceMode?: 'auto' | 'academic';
  status: 'loading' | 'draft' | 'refining' | 'started' | 'cancelled' | 'failed';
  /** Gather rounds this run will make (1 = quick single pass). */
  stages?: number;
  /** Rough end-to-end expectation shown on the card. */
  estMinutes?: number;
  /** Why the run failed — shown on the card with a Retry button. */
  error?: string;
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

export type View = 'lore' | 'chat' | 'settings' | 'document' | 'flashcards';
