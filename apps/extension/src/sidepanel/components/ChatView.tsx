import React, { useRef, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { LocalDocument, ChatMessage, ResearchPlan, ResolvedCitation } from '../types';
import { Send, StopCircle, Sparkles, ChevronDown, ChevronUp, Loader2, Microscope, Search, User, Copy, Check, Paperclip, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { paletteEntries, SlashCommand } from '../../lib/commands';
import { ErrorBoundary } from './ErrorBoundary';
import { MagpieEmptyIllustration } from './BrandMark';

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
  /** Live phase line for the thinking indicator ("Reading the page…"). */
  thinkingStatus?: Record<string, string>;
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

  /** True when the configured LLM endpoint is localhost (on-device) vs cloud. */
  llmEndpointLocal?: boolean;

  /** Research plan card actions. */
  onStartPlan?: (msgId: string, plan: ResearchPlan) => void;
  onCancelPlan?: (msgId: string) => void;

  /** Open an external http(s) link as an in-panel preview. */
  onOpenExternalLink?: (url: string) => void;

  customModel?: string;
  setCustomModel?: (val: string) => void;
  customModels?: string[];
  fetchCustomModels?: () => Promise<void>;
  customUrl?: string;
  toggleDoc?: (docId: string, enabled: boolean) => void;
  onUploadMarkdown?: () => void;
  onUploadPdf?: () => void;
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
  const directives = plan.subQuestions ?? [];

  return (
    <div className={`w-full rounded-xl border bg-card shadow-card overflow-hidden transition-opacity animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none ${
      plan.status === 'cancelled' ? 'border-border opacity-55' : 'border-border'
    }`}>
      {/* Card header: quiet label + status pill */}
      <div className="card-rule-thin flex items-center gap-2 px-3.5 pt-2.5 pb-2 bg-card">
        <Icon size={13} className="text-primary shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-muted-foreground flex-1">
          {modeName} · Plan
        </span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
          plan.status === 'started' ? 'bg-primary/10 text-primary' :
          plan.status === 'cancelled' ? 'bg-muted text-muted-foreground' :
          plan.status === 'failed' ? 'bg-red-500/15 text-red-600 dark:text-red-400' :
          isBusy ? 'bg-primary/10 text-primary animate-pulse motion-reduce:animate-none' :
          'bg-highlight/15 text-amber-700 dark:text-highlight'
        }`}>
          {plan.status === 'started' ? 'Running' :
           plan.status === 'cancelled' ? 'Cancelled' :
           plan.status === 'failed' ? 'Failed' :
           plan.status === 'loading' ? 'Planning…' :
           plan.status === 'refining' ? 'Revising…' : 'Draft'}
        </span>
      </div>

      <div className="px-3.5 py-3 space-y-3">
        {plan.status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Sparkles size={12} className="animate-pulse motion-reduce:animate-none text-primary" aria-hidden="true" />
            Resolving topic &amp; drafting the research plan…
          </div>
        ) : (
          <>
            <div>
              {/* The topic is content, not metadata — it gets the display voice */}
              <div className="font-display text-[17px] leading-snug text-foreground">{plan.effectiveTopic}</div>
              {plan.effectiveTopic !== plan.topic && (
                <div className="text-[10px] text-muted-foreground mt-1 font-mono">from: "{plan.topic}"</div>
              )}
            </div>

            {/* Pipeline spec line: what the run will do + what it costs */}
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {[`Gather${(plan.stages ?? 1) > 1 ? ` ×${plan.stages}` : ''}`, 'Analyze', 'Report'].map((phase, i) => (
                <React.Fragment key={phase}>
                  {i > 0 && <span className="text-border" aria-hidden="true">—</span>}
                  <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground/75">{phase}</span>
                </React.Fragment>
              ))}
              {plan.estMinutes && (
                <span className="ml-auto">~{plan.estMinutes} min</span>
              )}
            </div>

            {/* Directive ledger: numbered stops on the expedition, connected
                by a rail — each row is one thing the agent will go find out. */}
            {directives.length > 0 && (
              <ol className="relative">
                {directives.map((q, i) => (
                  <li key={i} className="relative flex gap-3 pb-2.5 last:pb-0 group">
                    {/* rail segment */}
                    {i < directives.length - 1 && (
                      <span className="absolute left-[9px] top-5 bottom-0 w-px bg-border" aria-hidden="true" />
                    )}
                    <span className="relative z-10 mt-0.5 w-[19px] h-[19px] shrink-0 rounded-full border border-primary/40 bg-card text-primary
                                     flex items-center justify-center text-[9px] font-mono font-bold tabular-nums
                                     group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                      {i + 1}
                    </span>
                    <span className="text-xs text-foreground/90 leading-relaxed pt-0.5">{q}</span>
                  </li>
                ))}
              </ol>
            )}

            {plan.status === 'failed' && (
              <div className="border-t border-border/60 pt-2.5 space-y-2">
                <div className="text-[11px] text-red-600 dark:text-red-400 leading-snug break-words">
                  Research failed{plan.error ? `: ${plan.error}` : ''}. Nothing was saved — retry to run the same plan again.
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1 h-8 text-xs font-semibold rounded-lg"
                    onClick={() => onStart?.(msgId, plan)}
                  >
                    Retry {plan.mode === 'deep' ? 'deep research' : 'research'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={() => onCancel?.(msgId)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {isPending && (
              <>
                <div className="text-[11px] text-muted-foreground border-t border-border/60 pt-2.5 leading-snug">
                  Type below to change the plan — "drop question 2", "focus on X instead" — or start it.
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1 h-8 text-xs font-semibold rounded-lg"
                    disabled={isBusy}
                    onClick={() => onStart?.(msgId, plan)}
                  >
                    {plan.mode === 'deep' ? 'Start deep research' : 'Start research'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground"
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
                           px-2.5 py-0.5 text-[11px] font-medium
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
                     px-2.5 py-0.5 text-[11px] font-medium
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
  /** Render markdown even mid-stream (research report). */
  renderLive?: boolean;
  resolveCitations: (text: string) => Promise<ResolvedCitation[]>;
  onOpenDocument?: (docId: string, anchorId?: string) => void;
  onOpenExternalLink?: (url: string) => void;
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

const MessageBody: React.FC<MessageBodyProps> = React.memo(({ text: rawText, compact, streaming, renderLive, resolveCitations, onOpenDocument, onOpenExternalLink }) => {
  const [citations, setCitations] = useState<Map<string, ResolvedCitation>>(new Map());
  // The raw-markdown plaintext fast-path is for fast token-by-token chat. The
  // research report streams as coalesced chunks and should arrive FORMATTED, so
  // renderLive opts it into full markdown mid-stream.
  const fastPath = !!streaming && !renderLive;

  // HOOK-ORDER RULE: every hook below runs on EVERY render, streaming or not.
  // A message flips streaming:true→false when it finalizes; if a hook sat
  // behind that branch the hook count would change mid-life → React #310
  // ("rendered more hooks than during the previous render") → white panel.
  // So the streaming FAST-PATH lives INSIDE each hook (skip the regex work),
  // and the `streaming` branch gates only the returned JSX — never a hook.

  // F2: on the plaintext fast-path, skip the O(N) regex/markdown passes — they
  // re-run on every delta. Pass rawText straight through; parse once it settles.
  const text = useMemo(
    () => fastPath ? rawText : normalizeLatexDelimiters(normalizeCitations(rawText)),
    [rawText, fastPath]
  );

  // Number the anchors in order of first appearance (skipped on the fast-path).
  const anchorOrder = useMemo(() => {
    if (fastPath) return [] as string[];
    const order: string[] = [];
    const regex = new RegExp(CITATION_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (!order.includes(m[1])) order.push(m[1]);
    }
    return order;
  }, [text, fastPath]);

  useEffect(() => {
    let alive = true;
    if (anchorOrder.length === 0) return undefined;  // also the streaming case
    // Debounced — resolve once the message settles, not per token.
    const timer = setTimeout(() => {
      resolveCitations(text).then(list => {
        if (!alive) return;
        setCitations(new Map(list.map(c => [c.anchorId, c])));
      }).catch(() => {});
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, anchorOrder.length]);

  // A11y: announce the FINISHED reply once, politely — never the token stream.
  // Streaming DOM mutations, if inside a live region, make screen readers
  // "chatter" fragmented tokens (a documented AI-chat failure mode). We keep the
  // live stream out of any live region and surface the whole coherent reply here
  // only when it settles (streaming true→false), so SR users get one clean read.
  const wasStreamingRef = useRef(false);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) setAnnounce(rawText);
    wasStreamingRef.current = !!streaming;
  }, [streaming, rawText]);

  // Plaintext fast-path render — AFTER all hooks, so hook order stays stable.
  // (renderLive messages fall through to the markdown renderer below.)
  if (fastPath) {
    return (
      <div>
        {/* aria-live=off: the growing token stream must NOT be announced live. */}
        <div aria-live="off" className={`whitespace-pre-wrap break-words font-sans ${compact ? 'text-xs' : 'text-sm'} text-foreground`}>
          {rawText}
          <span className="inline-block w-2 h-4 ml-0.5 align-middle bg-primary/60 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
        </div>
        <span className="sr-only" aria-live="polite">{announce}</span>
      </div>
    );
  }

  // Replace [anchor] markers with markdown links our renderer turns into chips
  const processed = text.replace(
    new RegExp(CITATION_REGEX.source, 'g'),
    (_full, anchor) => `[${anchorOrder.indexOf(anchor) + 1}](#cite:${anchor})`
  );

  return (
    <div>
      {/* Announced once when the reply settles (populated by the effect above). */}
      <span className="sr-only" aria-live="polite">{announce}</span>
      <div className={`prose prose-sm dark:prose-invert max-w-none prose-img:rounded-md prose-headings-display prose-a:text-primary prose-pre:rounded-md prose-pre:border prose-pre:border-border ${compact ? 'text-xs' : ''}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
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
              // External links open INSIDE the panel (preview + capture);
              // Cmd/Ctrl-click keeps the browser-tab escape hatch.
              if (href && /^https?:\/\//i.test(href) && onOpenExternalLink) {
                return (
                  <a
                    href={href}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      onOpenExternalLink(href);
                    }}
                    title={`${href}\n\nClick: open in current tab · Cmd/Ctrl-click: new tab · /follow for in-panel preview`}
                    {...props}
                  >
                    {children}
                  </a>
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
            <div className="text-xs font-medium text-muted-foreground mb-1.5">Sources</div>
            {/* One clean line per source: its citation number(s) + title link.
                (Per-chunk excerpt previews were noisy on long research reports.) */}
            <ol className="space-y-1 list-none p-0 m-0">
              {groups.map(group => {
                const nums = group.entries.map(e => e.idx + 1);
                const firstAnchor = group.entries[0].anchor;
                return (
                  <li key={group.docId} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <span className="font-semibold text-primary shrink-0 tabular-nums">
                      {nums.map(n => `[${n}]`).join('')}
                    </span>
                    <button
                      onClick={() => group.docId && onOpenDocument?.(group.docId, firstAnchor)}
                      className="text-left cursor-pointer bg-transparent border-none p-0 hover:text-primary hover:underline transition-colors leading-snug truncate max-w-[300px]"
                      title="Click to view source"
                    >
                      {group.docTitle}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })()}
    </div>
  );
}, (prev, next) =>
  prev.text === next.text &&
  prev.compact === next.compact &&
  // MUST compare streaming/renderLive: when a message finalizes (streaming
  // true→false) its text is often UNCHANGED (the last delta already delivered
  // the full answer; DONE adds nothing). Omitting these left the memo thinking
  // props were equal, so MessageBody never re-rendered off the plaintext
  // fast-path — the blinking caret and raw *markdown* stuck forever (worst on
  // general-knowledge answers, which have no citations to change the text).
  prev.streaming === next.streaming &&
  prev.renderLive === next.renderLive);

// ─────────────────────────────────────────────
// Copy Message Button Component
// ─────────────────────────────────────────────
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded bg-muted/50 border border-border/50 shadow-sm"
      title="Copy message text"
    >
      {copied ? (
        <>
          <Check size={10} className="text-emerald-500" />
          <span className="text-emerald-500 font-medium">Copied</span>
        </>
      ) : (
        <>
          <Copy size={10} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
};

// ─────────────────────────────────────────────
// Format Model Name Helper
// ─────────────────────────────────────────────
function formatModelName(model: string): string {
  if (!model) return '';
  let name = model.split('/').pop() || model;
  name = name.replace(/:beta|:free|-instruct|-exp|-preview/gi, '');
  name = name.replace(/-/g, ' ');
  return name.split(' ').map(word => {
    if (/^gpt/i.test(word)) return word.toUpperCase();
    if (/^gemini/i.test(word)) return 'Gemini';
    if (/^claude/i.test(word)) return 'Claude';
    if (/^llama/i.test(word)) return 'Llama';
    if (/^mixtral/i.test(word)) return 'Mixtral';
    if (/^mistral/i.test(word)) return 'Mistral';
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

// ─────────────────────────────────────────────
// Model Selector Component
// ─────────────────────────────────────────────
const ModelSelector: React.FC<{
  currentModel: string;
  models: string[];
  onSelect: (model: string) => void;
  onFetch: () => Promise<void>;
  isOpenRouter: boolean;
}> = ({ currentModel, models, onSelect, onFetch, isOpenRouter }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [fetching, setFetching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  const filteredModels = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return models;
    return models.filter(m => m.toLowerCase().includes(s));
  }, [models, search]);

  const triggerRefresh = async () => {
    setFetching(true);
    try {
      await onFetch();
    } catch (e) {
      console.error(e);
    } finally {
      setFetching(false);
    }
  };

  if (!isOpenRouter && models.length === 0) return null;

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border bg-card hover:bg-accent text-xs font-semibold text-foreground shadow-sm transition-colors"
      >
        <Sparkles size={11} className="text-primary shrink-0" />
        <span className="truncate max-w-[130px] font-sans text-xs font-semibold">{formatModelName(currentModel) || 'Select model…'}</span>
        <ChevronDown size={11} className="text-muted-foreground shrink-0" />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1.5 w-60 rounded-xl border border-border bg-popover text-popover-foreground shadow-card p-1.5 z-[100] flex flex-col gap-1.5 animate-in fade-in slide-in-from-bottom-2">
          {/* Search Input */}
          <div className="relative flex items-center">
            <Search size={12} className="absolute left-2.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-2.5 text-xs rounded-lg border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
              autoFocus
            />
          </div>

          {/* Models List */}
          <div className="max-h-48 overflow-y-auto no-scrollbar flex flex-col gap-0.5">
            {filteredModels.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground font-mono">
                No models found
              </div>
            ) : (
              filteredModels.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    onSelect(m);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors flex items-center justify-between gap-1.5 ${
                    m === currentModel
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'hover:bg-accent text-foreground'
                  }`}
                >
                  <span className="truncate flex flex-col items-start gap-0.5">
                    <span className="font-sans font-semibold text-xs leading-none">{formatModelName(m)}</span>
                    <span className={`font-mono text-[9px] truncate max-w-[170px] ${m === currentModel ? 'text-primary-foreground/75' : 'text-muted-foreground/60'}`}>{m}</span>
                  </span>
                  {m === currentModel && <span className="text-[9px] uppercase font-sans shrink-0">Active</span>}
                </button>
              ))
            )}
          </div>

          {/* Fetch Button for OpenRouter */}
          {isOpenRouter && (
            <div className="border-t border-border/60 pt-1.5 mt-0.5">
              <button
                type="button"
                onClick={triggerRefresh}
                disabled={fetching}
                className="w-full h-7 text-xs font-medium text-primary hover:bg-primary/5 border border-primary/20 rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                {fetching ? (
                  <>
                    <Loader2 size={11} className="animate-spin" /> Fetching…
                  </>
                ) : (
                  <>
                    <Sparkles size={11} /> Refresh OpenRouter Models
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// Add Context Dropdown Button (+ Button)
// ─────────────────────────────────────────────
const AddContextButton: React.FC<{
  onUploadMarkdown: () => void;
  onUploadPdf: () => void;
}> = ({ onUploadMarkdown, onUploadPdf }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative shrink-0 self-center pl-2">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="h-8 w-8 flex items-center justify-center rounded-lg border border-border hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-200 shadow-sm focus:outline-none"
        title="Add files"
        aria-label="Add files"
      >
        <Paperclip size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-45 text-primary' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1.5 w-64 rounded-xl border border-border bg-popover text-popover-foreground shadow-card p-1.5 z-[100] flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2">
          <button
            type="button"
            onClick={() => {
              if (onUploadPdf) onUploadPdf();
              setIsOpen(false);
            }}
            className="w-full text-left p-2 rounded-lg hover:bg-accent text-foreground flex items-start gap-3 transition-colors group"
          >
            <div className="h-8 w-8 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center shrink-0 group-hover:bg-red-500/20 transition-colors">
              <FileText size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold">Upload PDF Document</div>
              <div className="text-[10px] text-muted-foreground mt-0.5 leading-normal">Import academic papers, reports, or articles.</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              if (onUploadMarkdown) onUploadMarkdown();
              setIsOpen(false);
            }}
            className="w-full text-left p-2 rounded-lg hover:bg-accent text-foreground flex items-start gap-3 transition-colors group"
          >
            <div className="h-8 w-8 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0 group-hover:bg-indigo-500/20 transition-colors">
              <FileText size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold">Upload Markdown</div>
              <div className="text-[10px] text-muted-foreground mt-0.5 leading-normal">Import structured notes, outlines, or text.</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
};

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
  thinkingStatus = {},
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
  llmEndpointLocal = false,
  onStartPlan,
  onCancelPlan,
  onOpenExternalLink,
  customModel = '',
  setCustomModel,
  customModels = [],
  fetchCustomModels,
  customUrl = '',
  onUploadMarkdown,
  onUploadPdf
}) => {
  const msgEnd = useRef<HTMLDivElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  // Two-step clear confirmation
  const [confirmClear, setConfirmClear] = useState(false);
  // Slash-command palette keyboard navigation
  const [paletteIdx, setPaletteIdx] = useState(0);

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

  // Automatically fetch custom models on mount or when the endpoint url changes
  useEffect(() => {
    if (fetchCustomModels) {
      fetchCustomModels().catch(() => {});
    }
  }, [customUrl, fetchCustomModels]);

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

  const isEmpty = messages.length === 0;
  const hasDraftPlan = messages.some(m => m.plan && (m.plan.status === 'draft' || m.plan.status === 'refining'));

  // The field log is a running status panel, but a message the user QUEUES
  // during the run is newer than it — so the log must sit ABOVE the queued
  // messages, not pinned to the very bottom. Render it just before the first
  // queued message; if none, it stays at the end.
  const firstQueuedIdx = researching[activeProjectId] ? messages.findIndex(m => m.queued) : -1;
  const fieldLog = researching[activeProjectId] ? (
    <div className="flex justify-start" key="field-log">
      {/* The field log: night-ledger ink panel — the one dark surface in
          the app, reserved for the agent working through the stacks. */}
      <div className="w-full max-w-[95%] rounded-xl ink-panel shadow-card overflow-hidden animate-in fade-in motion-reduce:animate-none">
        <div className="flex items-center gap-2 px-3.5 py-2 border-b border-white/10">
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none text-highlight shrink-0" aria-hidden="true" />
          <span className="text-xs font-medium opacity-80 flex-1">
            Field log — chat stays open
          </span>
          <span className="text-[10px] font-mono opacity-50 tabular-nums">
            {(researchLogs[activeProjectId] || []).length} steps
          </span>
          <button
            type="button"
            onClick={cancelTask}
            className="text-[11px] font-medium opacity-70 border border-current rounded-md px-1.5 py-0.5 hover:opacity-100 hover:text-red-300 transition-opacity"
            aria-label="Stop research"
          >
            Stop
          </button>
        </div>
        <div className="px-3.5 py-2.5 space-y-1" aria-live="polite">
          {(researchLogs[activeProjectId] || []).slice(-3).map((line, i, arr) => (
            <div
              key={`${line}-${i}`}
              className={`text-[10px] font-mono truncate leading-relaxed ${i === arr.length - 1 ? 'text-highlight' : 'opacity-45'}`}
            >
              {line}
            </div>
          ))}
          {(researchLogs[activeProjectId] || []).length === 0 && (
            <div className="text-[10px] font-mono opacity-60">Warming up…</div>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden relative">
      {/* Context bar */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{documents.filter(d => d.enabled !== false).length} sources</span>
          {/* Where the answer is generated — retrieval/embeddings are always
              on-device; this flags whether the LLM endpoint is local or cloud. */}
          <span
            className={`flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-full border normal-case tracking-normal ${
              llmEndpointLocal
                ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
            }`}
            title={llmEndpointLocal
              ? 'Answers are generated by a local model on this device. Nothing leaves your machine.'
              : 'Retrieval & embeddings run on-device, but the LLM endpoint is a cloud provider — your prompt + retrieved context are sent there.'}
          >
            <span aria-hidden="true">{llmEndpointLocal ? '🔒' : '☁'}</span>
            {llmEndpointLocal ? 'Local' : 'Cloud'}
          </span>
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
          className={`h-6 text-xs px-2 rounded-md font-medium shrink-0 transition-colors ${
            confirmClear
              ? 'text-destructive bg-destructive/10 hover:bg-destructive hover:text-destructive-foreground'
              : 'text-muted-foreground'
          }`}
          onClick={handleClearClick}
          title={confirmClear ? 'Click again to confirm clear' : 'Clear chat history'}
        >
          {confirmClear ? 'Confirm?' : 'Clear'}
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
          <div className="flex flex-col items-center gap-2 pt-8 pb-3 text-center">
            <MagpieEmptyIllustration size={72} className="text-muted-foreground mb-2" />
            <div className="font-display text-xl text-foreground">Ask your treasure trove</div>
            <div className="w-8 border-t-2 border-[hsl(var(--rule)/0.6)]" aria-hidden="true" />
            <div className="text-xs text-muted-foreground max-w-[250px] leading-relaxed">
              Everything you've collected is searchable. Answers cite their sources.
            </div>
          </div>
        )}
        {isEmpty && (
          <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden text-xs">
            <div className="card-rule-thin px-4 pt-2.5 pb-2 text-xs font-medium text-muted-foreground">Start here</div>
            <div className="p-2.5 space-y-0.5">
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
                  className="w-full flex items-baseline gap-2 text-left hover:bg-accent transition-colors px-1.5 py-1.5 rounded-md"
                >
                  <span className="font-mono font-bold text-primary shrink-0">{cmd}</span>
                  <span className="text-muted-foreground truncate">{desc}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setInput('/help'); }}
                className="text-muted-foreground/70 hover:text-muted-foreground transition-colors mt-1 px-1.5 text-[11px]"
              >
                All commands: <span className="font-mono">/help</span> →
              </button>
            </div>
          </div>
        )}

        {messages.map((m, mi) => (
          <React.Fragment key={m.id}>
          {/* Field log sits just before the first message queued during the run. */}
          {mi === firstQueuedIdx && fieldLog}
          {m.plan ? (
          <div className="flex justify-start">
            <div className="w-full max-w-[95%]">
              <ErrorBoundary compact label="plan card">
                <PlanCard msgId={m.id} plan={m.plan} onStart={onStartPlan} onCancel={onCancelPlan} />
              </ErrorBoundary>
            </div>
          </div>
        ) : (
          <div key={m.id} className={`flex flex-col w-full ${m.role === 'user' ? 'items-end' : 'items-start'} gap-1`}>
            {/* Sender Header */}
            <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground/80">
              {m.role === 'user' ? (
                <>
                  <span>You</span>
                  <User size={10} className="text-muted-foreground/60" />
                </>
              ) : m.role === 'system' ? (
                <>
                  {m.streaming && <Loader2 size={10} className="text-muted-foreground/60 animate-spin" />}
                  <span>System</span>
                </>
              ) : (
                <>
                  <Sparkles size={10} className="text-primary shrink-0" />
                  <span>Magpie Assistant</span>
                  {/* Show the model that GENERATED this message (stored in provider field),
                      not the currently-selected model which changes all labels retroactively */}
                  {(m.provider && m.provider !== 'custom') ? (
                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                      {m.provider}
                    </span>
                  ) : customModel && m.streaming ? (
                    <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                      {customModel}
                    </span>
                  ) : null}
                </>
              )}
            </div>

            {m.queued && (
              <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-highlight/15 text-amber-700 dark:text-highlight px-2 py-0.5 text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                Queued — runs after research
              </span>
            )}

            <div
              // contain:layout — a growing/streaming bubble's internal reflow
              // stays scoped to this subtree instead of forcing a whole-document
              // layout pass on every token (documented streaming-chat CLS risk).
              className={`[contain:layout] w-full ${m.role === 'user' ? 'max-w-[85%]' : 'max-w-[92%]'} rounded-2xl border px-4 py-3 text-sm shadow-sm transition-all leading-relaxed ${
                m.role === 'user'
                  ? `bg-primary border-primary text-primary-foreground rounded-tr-sm ${m.queued ? 'opacity-70' : ''}`
                  : m.role === 'system'
                  ? 'bg-muted/40 border-border/60 text-muted-foreground w-full rounded-lg'
                  : 'bg-card border-border/80 text-card-foreground rounded-tl-sm'
              }`}
            >
              {/* One malformed message (broken markdown/KaTeX) must not white-
                  screen the whole panel — quarantine it per message. */}
              <ErrorBoundary compact label="message">
                {m.role === 'assistant' || m.role === 'system' ? (
                  <CollapsibleMessage text={m.text} streaming={m.streaming}>
                    <MessageBody text={m.text} compact={m.role === 'system'} streaming={m.streaming} renderLive={m.renderLive} resolveCitations={resolveCitations} onOpenDocument={onOpenDocument} onOpenExternalLink={onOpenExternalLink} />
                  </CollapsibleMessage>
                ) : (
                  <CollapsibleMessage text={m.text}>
                    <div className="whitespace-pre-wrap font-sans break-words">{m.text}</div>
                  </CollapsibleMessage>
                )}
              </ErrorBoundary>
            </div>

            {/* Action row for assistant messages */}
            {m.role === 'assistant' && !m.streaming && (
              <div className="flex items-center gap-2 px-1 mt-0.5 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <CopyButton text={m.text} />
              </div>
            )}
          </div>
          )}
          </React.Fragment>
        ))}
        {/* No message was queued during the run → field log stays at the end. */}
        {firstQueuedIdx === -1 && fieldLog}
        {generating[activeChatId] && !researching[activeProjectId] && (messages[messages.length - 1]?.role !== 'assistant' || !messages[messages.length - 1]?.text) && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg rounded-bl-sm border bg-card border-border text-card-foreground px-4 py-3 text-sm flex items-center gap-2 shadow-card">
              <div className="flex space-x-1" aria-hidden="true">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs text-muted-foreground font-medium" aria-live="polite">
                {thinkingStatus[activeChatId] || 'Thinking…'}
              </span>
            </div>
          </div>
        )}
        <div ref={msgEnd} />
      </div>

      {/* Input */}
      <div className="p-3 bg-background border-t border-border shrink-0 flex flex-col gap-2">
        {/* Model selection toolbar */}
        {(customUrl.includes('openrouter.ai') || customModels.length > 0) && (
          <div className="flex items-center justify-between px-1">
            <ModelSelector
              currentModel={customModel}
              models={customModels}
              onSelect={setCustomModel!}
              onFetch={fetchCustomModels!}
              isOpenRouter={customUrl.includes('openrouter.ai')}
            />
            <span className="text-[10px] text-muted-foreground font-mono">
              {documents.filter(d => d.enabled !== false).length} active source(s)
            </span>
          </div>
        )}

        <div className="relative flex items-end w-full rounded-xl border border-input bg-card shadow-card focus-within:border-primary/70 focus-within:ring-2 focus-within:ring-primary/15 transition-all">
          {input.startsWith('/') && !input.includes(' ') && (() => {
            const matches = paletteEntries(input, customCommands);
            if (matches.length === 0) return null;
            return (
              <div
                role="listbox"
                aria-label="Command suggestions"
                aria-activedescendant={`cmd-opt-${paletteIdx}`}
                className="absolute bottom-full left-0 mb-2 w-full bg-popover rounded-lg border border-border shadow-card p-1 z-50 animate-in fade-in slide-in-from-bottom-2 max-h-64 overflow-y-auto no-scrollbar"
              >
                {matches.map((c, i) => (
                  <div
                    key={c.cmd}
                    id={`cmd-opt-${i}`}
                    role="option"
                    aria-selected={i === paletteIdx}
                    className={`flex items-center gap-2 p-2 cursor-pointer text-sm transition-colors rounded-md ${i === paletteIdx ? 'bg-accent' : 'hover:bg-accent'}`}
                    onClick={() => { setInput(c.cmd + (c.takesArg ? ' ' : '')); setPaletteIdx(0); document.getElementById('chat-input')?.focus(); }}
                  >
                    <Sparkles size={14} className="text-primary shrink-0" aria-hidden="true" />
                    <span className="font-semibold font-mono text-foreground shrink-0">{c.cmd}</span>
                    <span className="text-muted-foreground text-[11px] truncate">{c.desc}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Add Context Button (+ Button) */}
          <AddContextButton
            onUploadMarkdown={onUploadMarkdown!}
            onUploadPdf={onUploadPdf!}
          />

          <textarea
            id="chat-input"
            rows={1}
            className="flex-1 w-full max-h-40 resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 font-sans no-scrollbar"
            placeholder={hasDraftPlan
              ? 'Refine the plan, or type "start"…'
              : 'Ask a question, or / for commands…'}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              setPaletteIdx(0); // reset palette selection on any input change
              // Auto-grow up to max-h; shrink back when cleared
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={e => {
              // Slash palette keyboard navigation
              if (input.startsWith('/') && !input.includes(' ')) {
                const matches = paletteEntries(input, customCommands);
                if (matches.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIdx(i => (i + 1) % matches.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIdx(i => (i - 1 + matches.length) % matches.length); return; }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const sel = matches[paletteIdx];
                    if (sel) { setInput(sel.cmd + (sel.takesArg ? ' ' : '')); setPaletteIdx(0); }
                    return;
                  }
                  if (e.key === 'Escape') { setInput(''); setPaletteIdx(0); return; }
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // While a reply streams, send() no-ops — typing stays possible
                // (the textarea is never disabled, so focus is never ejected).
                send();
                // Reset height after sending
                const el = e.currentTarget;
                requestAnimationFrame(() => { el.style.height = 'auto'; });
              }
            }}
            autoComplete="off"
            aria-label="Chat input"
          />
          <div className="pr-1.5 pb-1.5 flex shrink-0">
            {generating[activeChatId] ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-lg text-destructive hover:text-destructive hover:bg-destructive/10"
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
                className={`h-8 w-8 rounded-lg transition-colors ${input.trim() ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-muted-foreground'}`}
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
