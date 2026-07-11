import React, { useRef, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { LocalDocument, ChatMessage, ResearchPlan, ResolvedCitation } from '../types';
import { Send, StopCircle, Sparkles, ChevronDown, ChevronUp, Loader2, Microscope, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { paletteEntries, SlashCommand } from '../../lib/commands';

const CITATION_REGEX = /\[([a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?)\]/g;

interface ChatViewProps {
  messages: ChatMessage[];
  input: string;
  setInput: (val: string) => void;
  send: () => void;
  clearChat: () => void;
  cancelTask: () => void;
  activeChatId: string;
  activeProjectId: string;
  generating: Record<string, boolean>;
  researching: Record<string, boolean>;
  researchLogs: Record<string, string[]>;
  documents: LocalDocument[];
  resolveCitations: (text: string) => Promise<ResolvedCitation[]>;
  onOpenDocument?: (docId: string, anchorId?: string) => void;
  pageContextEnabled?: boolean;
  pageContextTitle?: string | null;
  onTogglePageContext?: () => void;
  /** Saved scroll position — restored when returning from a cited document. */
  scrollPosRef?: React.MutableRefObject<number | null>;
  /** Callback ref — caller stores a scrollToBottom() fn here for imperative use. */
  scrollToBottomRef?: React.MutableRefObject<(() => void) | null>;
  /** User-defined commands merged into the palette. */
  customCommands?: SlashCommand[];

  /** Whether this tab is currently visible — used to scroll to bottom on tab switch. */
  isActive?: boolean;

  /** Research plan card actions. */
  onStartPlan?: (msgId: string, plan: ResearchPlan) => void;
  onCancelPlan?: (msgId: string) => void;
}

// ─────────────────────────────────────────────
// Research plan card — the plan lives IN the chat.
// Draft plans are refined by simply typing in the chat input.
// ─────────────────────────────────────────────

interface PlanCardProps {
  msgId: string;
  plan: ResearchPlan;
  onStart?: (msgId: string, plan: ResearchPlan) => void;
  onCancel?: (msgId: string) => void;
}

const PlanCard: React.FC<PlanCardProps> = ({ msgId, plan, onStart, onCancel }) => {
  const Icon = plan.mode === 'deep' ? Microscope : Search;
  const modeName = plan.mode === 'deep' ? 'Deep Research' : 'Research';
  const isPending = plan.status === 'draft' || plan.status === 'refining';
  const isBusy = plan.status === 'loading' || plan.status === 'refining';

  return (
    <div className={`w-full rounded-lg border-2 shadow-card overflow-hidden transition-colors ${
      plan.status === 'cancelled' ? 'border-border/60 opacity-60' :
      plan.status === 'started' ? 'border-primary/40' : 'border-primary/60'
    }`}>
      {/* Header strip */}
      <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border-b border-primary/20">
        <Icon size={13} className="text-primary shrink-0" aria-hidden="true" />
        <span className="text-[10px] font-bold font-mono uppercase tracking-widest text-primary flex-1">
          {modeName} Plan
        </span>
        <span className={`text-[10px] font-bold font-mono uppercase tracking-widest px-1.5 py-0.5 rounded ${
          plan.status === 'started' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
          plan.status === 'cancelled' ? 'bg-muted text-muted-foreground' :
          isBusy ? 'bg-primary/15 text-primary animate-pulse' :
          'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        }`}>
          {plan.status === 'started' ? 'Running' :
           plan.status === 'cancelled' ? 'Cancelled' :
           plan.status === 'loading' ? 'Planning…' :
           plan.status === 'refining' ? 'Revising…' : 'Draft'}
        </span>
      </div>

      <div className="p-3 space-y-2.5 bg-card">
        {plan.status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 font-mono">
            <Sparkles size={12} className="animate-pulse text-primary" aria-hidden="true" />
            Resolving topic &amp; drafting sub-questions…
          </div>
        ) : (
          <>
            <div>
              <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Topic</div>
              <div className="text-sm font-mono text-foreground leading-snug">{plan.effectiveTopic}</div>
              {plan.effectiveTopic !== plan.topic && (
                <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">from: "{plan.topic}"</div>
              )}
            </div>

            {plan.subQuestions.length > 0 && (
              <div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Sub-questions</div>
                <ol className="space-y-1">
                  {plan.subQuestions.map((q, i) => (
                    <li key={i} className="text-xs font-mono text-foreground flex gap-2 leading-snug">
                      <span className="text-primary font-bold shrink-0 w-3 text-right">{i + 1}</span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {isPending && (
              <>
                <div className="text-[10px] font-mono text-muted-foreground border-t border-border/60 pt-2">
                  💬 Type below to change the plan — "drop question 2", "focus on X instead" — or start it.
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1 h-8 text-[10px] font-bold font-mono uppercase tracking-widest"
                    disabled={isBusy}
                    onClick={() => onStart?.(msgId, plan)}
                  >
                    {plan.mode === 'deep' ? 'Start Deep Research' : 'Start Research'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 text-[10px] font-mono border-2 border-border uppercase tracking-widest"
                    disabled={isBusy}
                    onClick={() => onCancel?.(msgId)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// Collapsible long message wrapper
// ─────────────────────────────────────────────

const COLLAPSE_WORD_THRESHOLD = 150;

interface CollapsibleMessageProps {
  text: string;
  streaming?: boolean;
  children: React.ReactNode;
}

const CollapsibleMessage: React.FC<CollapsibleMessageProps> = ({ text, streaming, children }) => {
  const wordCount = useMemo(() => text.split(/\s+/).filter(Boolean).length, [text]);
  const isLong = wordCount > COLLAPSE_WORD_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  if (!isLong || streaming) return <>{children}</>;

  return (
    <div className="relative">
      {/* Content — clamped when collapsed */}
      <div className={expanded ? undefined : 'max-h-64 overflow-hidden'}>
        {children}
      </div>

      {/* Collapsed: clickable gradient that expands on click */}
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Expand message"
          className="absolute bottom-0 left-0 right-0 h-16 flex items-end justify-center pb-1
                     bg-gradient-to-t from-card to-transparent
                     hover:from-card/90 transition-colors cursor-pointer w-full"
        >
          <span className="flex items-center gap-1 rounded-full bg-card border border-border
                           px-2.5 py-0.5 text-[10px] font-bold font-mono uppercase tracking-widest
                           text-muted-foreground shadow-sm">
            <ChevronDown size={10} />
            {wordCount} words
          </span>
        </button>
      )}

      {/* Expanded: collapse button at bottom */}
      {expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse message"
          className="mt-2 flex items-center gap-1 rounded-full border border-border
                     px-2.5 py-0.5 text-[10px] font-bold font-mono uppercase tracking-widest
                     text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        >
          <ChevronUp size={10} />
          Collapse
        </button>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// Message body — markdown + numbered citation chips
// ─────────────────────────────────────────────

interface MessageBodyProps {
  text: string;
  compact?: boolean;
  streaming?: boolean;
  resolveCitations: (text: string) => Promise<ResolvedCitation[]>;
  onOpenDocument?: (docId: string, anchorId?: string) => void;
}

// A single anchor, no surrounding brackets (used to normalize grouped citations)
const ANCHOR_SOURCE = /[a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?/;

/**
 * Models sometimes emit grouped citations like [a.s1.p2, b.s3.p4] instead of
 * [a.s1.p2][b.s3.p4]. The chip regex only matches one anchor per bracket, so
 * grouped ones leak as raw IDs. Split them into individual brackets first.
 */
function normalizeCitations(text: string): string {
  const groupRegex = new RegExp(
    `\\[(${ANCHOR_SOURCE.source}(?:\\s*,\\s*${ANCHOR_SOURCE.source})+)\\]`,
    'g'
  );
  return text.replace(groupRegex, (_full, group: string) =>
    group.split(',').map(a => `[${a.trim()}]`).join('')
  );
}

/**
 * Many LLMs emit LaTeX with \( \) / \[ \] delimiters (the "classic" TeX
 * style) instead of the $ / $$ that remark-math expects out of the box.
 * Convert both so either style renders. Code spans/fences are left alone
 * so backslashes inside code blocks aren't mangled.
 */
function normalizeLatexDelimiters(text: string): string {
  const codeSpanOrFence = /(```[\s\S]*?```|`[^`]*`)/g;
  const parts = text.split(codeSpanOrFence);
  for (let i = 0; i < parts.length; i++) {
    // Odd indices are the captured code spans/fences from the split — skip them
    if (i % 2 === 1) continue;
    parts[i] = parts[i].replace(/(\\)?\\\[([\s\S]*?)\\\]/g, (full, escape, inner) => {
      if (escape) return full; // It was an escaped bracket, so leave it alone
      return `$$${inner}$$`;
    }).replace(/(\\)?\\\(([\s\S]*?)\\\)/g, (full, escape, inner) => {
      if (escape) return full; // It was an escaped parenthesis, so leave it alone
      return `$${inner}$`;
    });
  }
  return parts.join('');
}

const MessageBody: React.FC<MessageBodyProps> = React.memo(({ text: rawText, compact, streaming, resolveCitations, onOpenDocument }) => {
  const [citations, setCitations] = useState<Map<string, ResolvedCitation>>(new Map());

  // F2: while streaming, render as plain text — no regex passes, no markdown parse.
  // The parser is O(N) in text length and re-runs on every delta; skipping it while
  // tokens are still arriving is the single biggest streaming-perf win.
  if (streaming) {
    return (
      <div>
        <div className={`whitespace-pre-wrap break-words font-sans ${compact ? 'text-xs' : 'text-sm'} text-foreground`}>
          {rawText}
          <span className="inline-block w-2 h-4 ml-0.5 align-middle bg-primary/60 animate-pulse" aria-hidden="true" />
        </div>
      </div>
    );
  }

  // F7: memoize the regex passes so the fully-rendered path doesn't rescan on every parent re-render.
  const text = useMemo(() => normalizeLatexDelimiters(normalizeCitations(rawText)), [rawText]);

  // Number the anchors in order of first appearance
  const anchorOrder = useMemo(() => {
    const order: string[] = [];
    const regex = new RegExp(CITATION_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (!order.includes(m[1])) order.push(m[1]);
    }
    return order;
  }, [text]);

  useEffect(() => {
    let alive = true;
    if (anchorOrder.length === 0) return undefined;
    // Debounced — during streaming `text` changes per token; only resolve
    // once the message settles instead of hammering the service worker.
    const timer = setTimeout(() => {
      resolveCitations(text).then(list => {
        if (!alive) return;
        setCitations(new Map(list.map(c => [c.anchorId, c])));
      }).catch(() => {});
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Replace [anchor] markers with markdown links our renderer turns into chips
  const processed = text.replace(
    new RegExp(CITATION_REGEX.source, 'g'),
    (_full, anchor) => `[${anchorOrder.indexOf(anchor) + 1}](#cite:${anchor})`
  );

  return (
    <div>
      <div className={`prose prose-sm dark:prose-invert max-w-none prose-img:rounded-md prose-headings-display prose-a:text-primary prose-pre:rounded-md prose-pre:border prose-pre:border-border ${compact ? 'text-xs' : ''}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { strict: false }]]}
          urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
          components={{
            a: ({ href, children, ...props }) => {
              if (href?.startsWith('#cite:')) {
                const anchor = href.slice(6);
                const cite = citations.get(anchor);
                return (
                  // button instead of span: keyboard-focusable, announced as interactive by screen readers
                  <button
                    type="button"
                    className="inline-flex items-center justify-center px-1.5 mx-0.5 text-[10px] font-mono font-bold rounded bg-primary/10 text-primary border border-primary/30 cursor-pointer hover:bg-primary/20 transition-colors no-underline align-super focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    aria-label={cite ? `Citation ${String(children)}: ${cite.docTitle}${cite.sectionPath ? ` — ${cite.sectionPath}` : ''}` : `Source: ${anchor}`}
                    title={cite ? `${cite.docTitle}${cite.sectionPath ? ` — ${cite.sectionPath}` : ''}\n\nClick to view source` : `Source: ${anchor}`}
                    onClick={() => cite?.docId && onOpenDocument?.(cite.docId, anchor)}
                  >
                    {children}
                  </button>
                );
              }
              return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
            }
          }}
        >
          {processed}
        </ReactMarkdown>
      </div>

      {/* Sources footer — grouped by document */}
      {anchorOrder.length > 0 && citations.size > 0 && (() => {
        // Group citations by docId, preserving order
        const groups: { docId: string; docTitle: string; entries: { idx: number; anchor: string; cite: ResolvedCitation }[] }[] = [];
        const groupMap = new Map<string, number>();
        anchorOrder.forEach((anchor, idx) => {
          const cite = citations.get(anchor);
          if (!cite) return;
          const existing = groupMap.get(cite.docId);
          if (existing !== undefined) {
            groups[existing].entries.push({ idx, anchor, cite });
          } else {
            groupMap.set(cite.docId, groups.length);
            groups.push({ docId: cite.docId, docTitle: cite.docTitle, entries: [{ idx, anchor, cite }] });
          }
        });

        return (
          <div className="mt-3 pt-2 border-t border-border/60">
            {/* Sources section label — text-xs floor for legibility */}
            <div className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Sources</div>
            <div className="space-y-2">
              {groups.map(group => (
                <div key={group.docId}>
                  <div className="text-xs font-mono font-bold text-foreground/80 mb-0.5">{group.docTitle}</div>
                  {/* pl-2 indent without side-stripe border */}
                  <div className="space-y-0.5 pl-2">
                    {group.entries.map(({ idx, anchor, cite }) => {
                      // Show a short preview of the chunk text to distinguish entries
                      const preview = cite.chunkText
                        ? cite.chunkText.replace(/\s+/g, ' ').slice(0, 80) + (cite.chunkText.length > 80 ? '…' : '')
                        : cite.heading && cite.heading !== 'Document' ? cite.heading : 'View source';
                      return (
                        <div key={anchor} className="flex items-start gap-1.5 text-[10px] font-mono text-muted-foreground">
                          <span className="font-bold text-primary shrink-0 mt-px">[{idx + 1}]</span>
                          <button
                            onClick={() => cite.docId && onOpenDocument?.(cite.docId, anchor)}
                            className="text-left cursor-pointer bg-transparent border-none p-0 hover:text-primary hover:underline transition-colors leading-snug truncate max-w-[280px]"
                            title={`${preview}\n\nClick to view highlighted source`}
                          >
                            {preview}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}, (prev, next) => prev.text === next.text && prev.compact === next.compact);

// ─────────────────────────────────────────────
// Chat view
// ─────────────────────────────────────────────

export const ChatView: React.FC<ChatViewProps> = ({
  messages,
  input,
  setInput,
  send,
  clearChat,
  cancelTask,
  activeChatId,
  activeProjectId,
  generating,
  researching,
  researchLogs,
  documents,
  resolveCitations,
  onOpenDocument,
  pageContextEnabled = false,
  pageContextTitle = null,
  onTogglePageContext,
  scrollPosRef,
  scrollToBottomRef,
  customCommands = [],
  isActive = false,
  onStartPlan,
  onCancelPlan
}) => {
  const msgEnd = useRef<HTMLDivElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  // Two-step clear confirmation
  const [confirmClear, setConfirmClear] = useState(false);

  // Returning from a cited document: put the reader back on the message they
  // were reading instead of jumping to the bottom. The flag suppresses the
  // auto-scroll effect exactly once (both effects fire on mount, in order).
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (scrollPosRef?.current != null && scrollBox.current) {
      scrollBox.current.scrollTop = scrollPosRef.current;
      restoredScroll.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to bottom only when tab transitions from hidden → visible
  const wasActive = useRef(isActive);
  useEffect(() => {
    const becameActive = isActive && !wasActive.current;
    wasActive.current = isActive;
    if (becameActive) {
      msgEnd.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [isActive]);

  // Register imperative scrollToBottom so parent can call it on nav clicks
  useEffect(() => {
    if (scrollToBottomRef) {
      scrollToBottomRef.current = () => msgEnd.current?.scrollIntoView({ behavior: 'instant' });
    }
    return () => { if (scrollToBottomRef) scrollToBottomRef.current = null; };
  }, [scrollToBottomRef]);

  useEffect(() => {
    if (restoredScroll.current) { restoredScroll.current = false; return; }
    // F4: smooth-scroll animations contend with layout during streaming.
    // Use instant scroll while tokens are still arriving; smooth when idle.
    const behavior: ScrollBehavior = generating[activeChatId] || researching[activeProjectId] ? 'auto' : 'smooth';
    msgEnd.current?.scrollIntoView({ behavior });
  }, [messages, generating, researching, activeChatId, activeProjectId]);



  const handleClearClick = () => {
    if (confirmClear) {
      setConfirmClear(false);
      clearChat();
    } else {
      setConfirmClear(true);
      // Auto-cancel the confirm state after 3s if user doesn't act
      setTimeout(() => setConfirmClear(false), 3000);
    }
  };

  const isEmpty = messages.length === 0 || (messages.length === 1 && messages[0].id === 'welcome');
  const hasDraftPlan = messages.some(m => m.plan && (m.plan.status === 'draft' || m.plan.status === 'refining'));

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden relative">
      {/* Context bar */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2 min-w-0 text-[10px] text-muted-foreground font-bold font-mono uppercase tracking-widest">
          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{documents.filter(d => d.enabled !== false).length} SOURCES</span>
          {/* Ephemeral page context toggle — chat about the current tab without capturing it */}
          {pageContextTitle && onTogglePageContext && (
            <button
              type="button"
              onClick={onTogglePageContext}
              aria-label={pageContextEnabled
                ? `Page context on: ${pageContextTitle}. Click to disable.`
                : `Page context off: ${pageContextTitle}. Click to include this page in chat.`}
              aria-pressed={pageContextEnabled}
              className={`flex items-center gap-1 min-w-0 px-1.5 py-0.5 rounded-full border transition-colors normal-case tracking-normal ${
                pageContextEnabled
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
              }`}
              title={pageContextEnabled
                ? `Current page is included in chat context (not saved): ${pageContextTitle}`
                : `Click to include the current page in chat context (not saved): ${pageContextTitle}`}
            >
              <span className="shrink-0" aria-hidden="true">📄</span>
              <span className="truncate max-w-[130px]">{pageContextTitle}</span>
              <span className="shrink-0 font-bold uppercase" aria-hidden="true">{pageContextEnabled ? 'ON' : 'OFF'}</span>
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 text-[10px] px-2 rounded-md font-bold font-mono uppercase tracking-widest shrink-0 transition-colors ${
            confirmClear
              ? 'text-destructive border-2 border-destructive/40 bg-destructive/10 hover:bg-destructive hover:text-destructive-foreground'
              : 'text-muted-foreground'
          }`}
          onClick={handleClearClick}
          title={confirmClear ? 'Click again to confirm clear' : 'Clear chat history'}
        >
          {confirmClear ? 'CONFIRM?' : '[CLEAR]'}
        </Button>
      </div>

      {/* Messages */}
      <div
        ref={scrollBox}
        onScroll={(e) => { if (scrollPosRef) scrollPosRef.current = e.currentTarget.scrollTop; }}
        className="flex-1 overflow-y-auto no-scrollbar p-4 space-y-6"
      >
        {/* Command hint card — shown in empty state to surface slash commands */}
        {isEmpty && (
          <div className="flex flex-col items-center gap-1 pt-6 pb-2 text-center">
            <div className="text-sm font-bold font-mono uppercase tracking-widest text-foreground">Ask your treasure trove</div>
            <div className="text-xs font-mono text-muted-foreground max-w-[260px]">
              Everything you've collected is searchable. Answers cite their sources.
            </div>
          </div>
        )}
        {isEmpty && (
          <div className="rounded-lg border border-border bg-card shadow-card p-4 text-xs font-mono">
            <div className="font-bold uppercase tracking-widest text-muted-foreground mb-2">Start here</div>
            <div className="space-y-1">
              {[
                { cmd: '/research', desc: 'Search the web, get a cited report' },
                { cmd: '/deepresearch', desc: 'Deeper: web + papers + news, cross-checked' },
                { cmd: '/analyze', desc: 'Summarize everything in this workspace' },
                { cmd: '/create-skill', desc: 'Turn your findings into a reusable command' },
              ].map(({ cmd, desc }) => (
                <button
                  key={cmd}
                  type="button"
                  onClick={() => setInput(cmd + ' ')}
                  className="w-full flex items-center gap-2 text-left hover:bg-accent transition-colors p-1.5 rounded-md"
                >
                  <span className="font-bold text-primary shrink-0">{cmd}</span>
                  <span className="text-muted-foreground truncate">{desc}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setInput('/help'); }}
                className="text-muted-foreground/60 hover:text-muted-foreground transition-colors mt-1 text-[10px] uppercase tracking-widest"
              >
                All commands: /help →
              </button>
            </div>
          </div>
        )}

        {messages.map(m => m.plan ? (
          <div key={m.id} className="flex justify-start">
            <div className="w-full max-w-[95%]">
              <PlanCard msgId={m.id} plan={m.plan} onStart={onStartPlan} onCancel={onCancelPlan} />
            </div>
          </div>
        ) : (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg border px-4 py-2.5 text-sm shadow-card ${
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground border-primary rounded-br-sm'
                  : m.role === 'system'
                  ? 'bg-muted/50 border-border text-muted-foreground w-full'
                  : 'bg-card border-border text-card-foreground rounded-bl-sm'
              }`}
            >
              {m.role === 'assistant' || m.role === 'system' ? (
                <CollapsibleMessage text={m.text} streaming={m.streaming}>
                  <MessageBody text={m.text} compact={m.role === 'system'} streaming={m.streaming} resolveCitations={resolveCitations} onOpenDocument={onOpenDocument} />
                </CollapsibleMessage>
              ) : (
                <CollapsibleMessage text={m.text}>
                  <div className="whitespace-pre-wrap font-mono">{m.text}</div>
                </CollapsibleMessage>
              )}
            </div>
          </div>
        ))}
        {generating[activeChatId] && !researching[activeProjectId] && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg rounded-bl-sm border bg-card border-border text-card-foreground px-4 py-3 text-sm flex items-center gap-2 shadow-card">
              <div className="flex space-x-1" aria-hidden="true">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-[10px] text-muted-foreground font-bold font-mono uppercase tracking-widest" aria-live="polite">
                THINKING...
              </span>
            </div>
          </div>
        )}
        {researching[activeProjectId] && (
          <div className="flex justify-start">
            <div className="w-full max-w-[95%] rounded-lg border-2 border-primary/40 bg-card text-card-foreground shadow-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border-b border-primary/20">
                <Loader2 size={13} className="animate-spin text-primary shrink-0" aria-hidden="true" />
                <span className="text-[10px] text-primary font-bold font-mono uppercase tracking-widest flex-1">
                  Researching — chat stays open
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {(researchLogs[activeProjectId] || []).length} steps
                </span>
                <button
                  type="button"
                  onClick={cancelTask}
                  className="text-[10px] font-bold font-mono uppercase tracking-widest text-destructive border border-destructive/40 rounded px-1.5 py-0.5 hover:bg-destructive hover:text-destructive-foreground transition-colors"
                  aria-label="Stop research"
                >
                  Stop
                </button>
              </div>
              <div className="px-3 py-2 space-y-0.5" aria-live="polite">
                {(researchLogs[activeProjectId] || []).slice(-3).map((line, i, arr) => (
                  <div
                    key={`${line}-${i}`}
                    className={`text-[10px] font-mono truncate ${i === arr.length - 1 ? 'text-foreground' : 'text-muted-foreground/70'}`}
                  >
                    {line}
                  </div>
                ))}
                {(researchLogs[activeProjectId] || []).length === 0 && (
                  <div className="text-[10px] font-mono text-muted-foreground">Warming up…</div>
                )}
              </div>
            </div>
          </div>
        )}
        <div ref={msgEnd} />
      </div>

      {/* Input */}
      <div className="p-3 bg-background border-t border-border shrink-0">
        <div className="relative flex items-end w-full rounded-lg border-2 border-input bg-card shadow-card focus-within:border-primary transition-colors">
          {input.startsWith('/') && !input.includes(' ') && (() => {
            const matches = paletteEntries(input, customCommands);
            if (matches.length === 0) return null;
            return (
              <div
                role="listbox"
                aria-label="Command suggestions"
                className="absolute bottom-full left-0 mb-2 w-full bg-popover rounded-lg border border-border shadow-card p-1 z-50 animate-in fade-in slide-in-from-bottom-2 max-h-64 overflow-y-auto no-scrollbar"
              >
                {matches.map(c => (
                  <div
                    key={c.cmd}
                    role="option"
                    aria-selected={false}
                    className="flex items-center gap-2 p-2 hover:bg-accent cursor-pointer text-sm transition-colors rounded-md"
                    onClick={() => { setInput(c.cmd + (c.takesArg ? ' ' : '')); document.getElementById('chat-input')?.focus(); }}
                  >
                    <Sparkles size={14} className="text-primary shrink-0" aria-hidden="true" />
                    <span className="font-bold font-mono text-foreground uppercase tracking-widest shrink-0">{c.cmd.toUpperCase()}</span>
                    <span className="text-muted-foreground text-[10px] font-mono uppercase truncate">{c.desc}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          <textarea
            id="chat-input"
            rows={1}
            className="flex w-full max-h-40 resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 font-mono no-scrollbar"
            placeholder={hasDraftPlan
              ? 'Refine the plan, or type "start"…'
              : 'Ask a question, or / for commands…'}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              // Auto-grow up to max-h; shrink back when cleared
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
                // Reset height after sending
                const el = e.currentTarget;
                requestAnimationFrame(() => { el.style.height = 'auto'; });
              }
            }}
            disabled={generating[activeChatId]}
            autoComplete="off"
            aria-label="Chat input"
          />
          <div className="pr-1 flex shrink-0">
            {generating[activeChatId] ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-md text-destructive hover:text-destructive border-2 border-transparent hover:border-destructive hover:bg-destructive/10"
                onClick={cancelTask}
                title="Stop generation"
                aria-label="Stop generation"
              >
                <StopCircle size={18} />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 rounded-md transition-colors border-2 ${input.trim() ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90' : 'text-muted-foreground border-transparent'}`}
                onClick={send}
                disabled={!input.trim()}
                title="Send message"
                aria-label="Send message"
              >
                <Send size={14} className={input.trim() ? 'ml-0.5' : ''} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
