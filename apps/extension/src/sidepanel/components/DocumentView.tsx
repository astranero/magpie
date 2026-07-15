import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { LocalDocument, ResolvedCitation } from '../types';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ExternalLink, FileText, Check } from 'lucide-react';
import { splitFrontmatter, parseFrontmatterFields } from '../../lib/frontmatter';

// Same inline anchor format the chat renderer uses: [d3ab01.s1.p2] / [d3.s0.p1.0].
// A research report's body carries these; some are pre-linkified to [[n](url)] by
// linkifyReportCitations (known sources), but any whose docShortId wasn't in the
// report's `sources` array stay raw. This regex catches the raw ones so we can turn
// them into clickable chips that jump to the exact source chunk — resolved straight
// from the chunk store, so it works even when the source list is incomplete.
const CITATION_REGEX = /\[([a-z]\w{1,8}\.s\d+\.p\d+(?:\.\d+)?)\]/g;

interface DocumentViewProps {
  document: LocalDocument | null;
  highlightAnchorId?: string | null;
  onBack: () => void;
  timeAgo: (iso: string) => string;
  /** Open an external http(s) link as an in-panel preview instead of a tab. */
  onOpenExternalLink?: (url: string) => void;
  /** Jump to a source document at a specific chunk (citation chips). */
  onOpenDocument?: (docId: string, anchorId?: string) => void;
  /** Resolve [anchor] markers to their source doc/chunk via the chunk store. */
  resolveCitations?: (text: string) => Promise<ResolvedCitation[]>;
}

/** Shared markdown link renderer: `#cite:` anchors become chunk-jump chips;
 *  http(s) links open in-panel by default, real tab on Cmd/Ctrl-click. Falls
 *  back to target=_blank when no handler is wired. */
function makeMdComponents(
  onOpenExternalLink?: (url: string) => void,
  citations?: Map<string, ResolvedCitation>,
  onOpenDocument?: (docId: string, anchorId?: string) => void,
) {
  return {
    a: ({ href, children, ...props }: any) => {
      // Internal citation chip — jump to the exact chunk the claim came from.
      if (typeof href === 'string' && href.startsWith('#cite:')) {
        const anchor = href.slice(6);
        const cite = citations?.get(anchor);
        return (
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
      if (href && /^https?:\/\//i.test(href) && onOpenExternalLink) {
        return (
          <a
            href={href}
            onClick={(e: React.MouseEvent) => {
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
  };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Highlight offsets and rendering must share ONE coordinate space: the
// frontmatter-stripped body. Matching against the raw stored content while
// rendering the stripped body shifted every highlight by the YAML length.
// Splitting/parsing lives in lib/frontmatter.ts so it's shared and tested.
const stripFrontmatter = (content: string): string => splitFrontmatter(content).body;

interface ChunkHighlight {
  charStart: number;
  charEnd: number;
  text: string;
}

export const DocumentView: React.FC<DocumentViewProps> = ({
  document,
  highlightAnchorId,
  onBack,
  timeAgo,
  onOpenExternalLink,
  onOpenDocument,
  resolveCitations,
}) => {
  const [highlight, setHighlight] = useState<ChunkHighlight | null>(null);
  const [citeCopied, setCiteCopied] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch chunk data when highlightAnchorId changes
  useEffect(() => {
    if (!highlightAnchorId || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      setHighlight(null);
      return;
    }

    chrome.runtime.sendMessage(
      { action: 'GET_CHUNK_BY_ANCHOR', anchorId: highlightAnchorId },
      (res: any) => {
        if (res?.success && res.chunk) {
          const chunkText: string = res.chunk.text || '';
          // Same string the view renders — offsets are only valid in it.
          const fullText = stripFrontmatter(document?.content || '');

          // Stored charStart/charEnd are computed against the *cleaned*
          // content (see lib/content-cleaner.ts: noise stripping, blank-line
          // collapsing, paragraph dedup), which can drift from the raw
          // content actually saved as document.content. Locate the chunk's
          // real text directly instead of trusting stored offsets.
          const exactIdx = chunkText ? fullText.indexOf(chunkText) : -1;

          if (exactIdx !== -1) {
            setHighlight({ charStart: exactIdx, charEnd: exactIdx + chunkText.length, text: chunkText });
            return;
          }

          if (chunkText) {
            // Fallback 1: whitespace-flexible match (content-cleaner collapses
            // blank lines; chunk merging joins paragraphs differently). Cap
            // the pattern source so pathological chunks can't blow up regex.
            const probe = chunkText.slice(0, 600);
            const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flexible = escaped.replace(/\s+/g, '\\s+');
            try {
              const match = new RegExp(flexible).exec(fullText);
              if (match) {
                setHighlight({ charStart: match.index, charEnd: match.index + Math.max(match[0].length, Math.min(chunkText.length, fullText.length - match.index)), text: chunkText });
                return;
              }
            } catch { /* regex too complex/long — fall through */ }

            // Fallback 2: anchor on the chunk's opening sentence.
            const opening = chunkText.slice(0, 100).trim();
            const openIdx = opening.length >= 30 ? fullText.indexOf(opening) : -1;
            if (openIdx !== -1) {
              setHighlight({ charStart: openIdx, charEnd: Math.min(openIdx + chunkText.length, fullText.length), text: chunkText });
              return;
            }

            // Give up on precise highlighting — still surface the chunk text
            // so the citation isn't a dead end.
            setHighlight({ charStart: -1, charEnd: -1, text: chunkText });
            return;
          }

          setHighlight(null);
        } else {
          setHighlight(null);
        }
      }
    );
  }, [highlightAnchorId, document]);

  // Scroll to highlighted chunk after render
  useEffect(() => {
    if (highlight && highlightRef.current) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [highlight]);

  // Declared BEFORE the `!document` early return: hooks must run on every
  // render regardless of branch, else opening a doc (null→present) changes
  // the hook count → React #310 → white panel.
  const [showRaw, setShowRaw] = React.useState(false);

  // ── Inline citation chips ──────────────────────────────────────────────
  // A research report's body carries [anchor] markers. DocumentView had no
  // resolver (only ChatView did), so they rendered as dead raw text and links
  // opened the external page instead of the extracted chunk. Resolve them here
  // the same way — DB-backed, so a chip works even when the report's own
  // sources list is missing that doc.
  const [citations, setCitations] = useState<Map<string, ResolvedCitation>>(new Map());

  // The text we scan for citations: the frontmatter-stripped body. Computed
  // here (not from the later `body`) so the hooks below run before any return.
  const citeBody = useMemo(
    () => (document?.content ? splitFrontmatter(document.content).body : ''),
    [document]
  );

  // Number anchors by first appearance (matches the chat renderer's scheme).
  const anchorOrder = useMemo(() => {
    const order: string[] = [];
    const re = new RegExp(CITATION_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(citeBody)) !== null) {
      if (!order.includes(m[1])) order.push(m[1]);
    }
    return order;
  }, [citeBody]);

  // Resolve raw anchors to source doc/chunk (debounced so it settles once).
  useEffect(() => {
    if (!resolveCitations || anchorOrder.length === 0) { setCitations(new Map()); return; }
    let alive = true;
    const timer = setTimeout(() => {
      resolveCitations(citeBody).then(list => {
        if (alive) setCitations(new Map(list.map(c => [c.anchorId, c])));
      }).catch(() => {});
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [citeBody, anchorOrder.length, resolveCitations]);

  const mdComponents = makeMdComponents(onOpenExternalLink, citations, onOpenDocument);

  // Turn raw [anchor] markers into numbered #cite links our renderer makes into
  // clickable chips. Unknown anchors (not seen during numbering) are left as-is.
  const linkifyAnchors = (s: string): string =>
    s.replace(CITATION_REGEX, (full, anchor: string) => {
      const n = anchorOrder.indexOf(anchor);
      return n >= 0 ? `[${n + 1}](#cite:${anchor})` : full;
    });

  if (!document) {
    return (
      <div className="flex-1 flex flex-col p-4">
        <Button variant="outline" className="w-fit mb-4" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
        <p>Document not found.</p>
      </div>
    );
  }

  const hostname = document.url ? safeHostname(document.url) : null;
  const content = document.content || '*No content available for this document.*';

  // Parse frontmatter at top if present (tolerate BOM / leading whitespace)
  let fmFields: Array<[string, string]> = [];
  let fmTags: string[] = [];
  let body = content;
  if (document && document.content) {
    const { yaml, body: split } = splitFrontmatter(document.content);
    if (yaml !== null) {
      body = split;
      const parsed = parseFrontmatterFields(yaml);
      fmFields = parsed.fields;
      fmTags = parsed.tags;
    }
  }

  const contentToRender = showRaw ? content : body;

  // Humanize known frontmatter values for display
  const prettyFmValue = (key: string, v: string): string => {
    if (key === 'captured') {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
    }
    if (key === 'word count') {
      const n = Number(v);
      if (Number.isFinite(n)) return `${n.toLocaleString()} words`;
    }
    return v;
  };
  // `created` duplicates `captured`'s date; skip it in the card
  const cardFields = fmFields.filter(([k]) => k !== 'title' && k !== 'created');

  const metadataCard = fmFields.length > 0 && (
    <div className="card-rule mb-5 rounded-lg border border-border bg-card shadow-card px-4 py-3 pb-4">
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="text-[11px] font-medium text-muted-foreground">Metadata</div>
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="text-[10px] font-mono text-muted-foreground/60 hover:text-primary transition-colors"
          title="Toggle raw markdown (with YAML frontmatter)"
        >
          {showRaw ? 'rendered view' : 'raw'}
        </button>
      </div>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs font-mono items-baseline">
        {cardFields.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-muted-foreground text-[10px] truncate">{k}</dt>
            <dd className="min-w-0">
              {/^https?:\/\//.test(v)
                ? <a href={v} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">{v}</a>
                : <span className="break-words">{prettyFmValue(k, v)}</span>}
            </dd>
          </React.Fragment>
        ))}
        {fmTags.length > 0 && (
          <>
            <dt className="text-muted-foreground text-[10px]">tags</dt>
            <dd className="min-w-0 flex flex-wrap gap-1">
              {fmTags.map(t => (
                <span key={t} className="px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10px]">
                  {t}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );

  // Split content into segments: before highlight, the highlight, and after
  const renderContent = () => {
    if (!highlight || !document.content) {
      return (
           <ReactMarkdown
           remarkPlugins={[remarkGfm, remarkMath]}
           rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
           urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
           components={mdComponents}
         >
           {showRaw ? contentToRender : linkifyAnchors(contentToRender)}
         </ReactMarkdown>
      );
    }

    const { charStart, charEnd } = highlight;
    const fullText = body;

    // No reliable location found in the document (e.g. content edited since
    // the chunk was indexed) — show the full doc, plus the cited excerpt as
    // a standalone callout so the citation still points somewhere useful.
    if (charStart < 0 || charEnd < 0) {
      return (
        <>
          <div
            ref={highlightRef}
            className="rounded-lg border border-primary/50 bg-primary/5 shadow-card p-3 mb-4"
          >
            <div className="text-xs font-medium text-primary mb-2 pb-1.5 border-b-2 border-primary/20">
              [CITED] Position not found — doc may have changed
            </div>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
              urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
              components={mdComponents}
            >
              {linkifyAnchors(highlight.text)}
            </ReactMarkdown>
          </div>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
            urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
            components={mdComponents}
          >
            {linkifyAnchors(fullText)}
          </ReactMarkdown>
        </>
      );
    }

    // Clamp to valid bounds
    const start = Math.max(0, Math.min(charStart, fullText.length));
    const end = Math.max(start, Math.min(charEnd, fullText.length));

    const before = fullText.slice(0, start);
    const highlighted = fullText.slice(start, end);
    const after = fullText.slice(end);

    return (
      <>
        {before && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
            urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
            components={mdComponents}
          >
            {linkifyAnchors(before)}
          </ReactMarkdown>
        )}
        <div
          ref={highlightRef}
          className="rounded-lg border border-primary/50 bg-primary/5 shadow-card p-3 my-2 transition-all duration-500"
        >
          <div className="text-xs font-medium text-primary mb-2 pb-1.5 border-b-2 border-primary/20">
            [CITED]
          </div>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
            urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
            components={mdComponents}
          >
            {linkifyAnchors(highlighted)}
          </ReactMarkdown>
        </div>
        {after && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
            urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
            components={mdComponents}
          >
            {linkifyAnchors(after)}
          </ReactMarkdown>
        )}
      </>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b border-border bg-card shrink-0">
        <Button variant="outline" size="sm" onClick={onBack} className="border border-primary/50 rounded-lg">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
        {document.bibtex && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 font-mono text-xs rounded-lg"
            title="Copy BibTeX citation to clipboard"
            onClick={() => {
              navigator.clipboard.writeText(document.bibtex!).then(
                () => setCiteCopied(true),
                () => {}
              );
              setTimeout(() => setCiteCopied(false), 2000);
            }}
          >
            {citeCopied ? <><Check size={13} className="mr-1" aria-hidden="true" /> Copied</> : <><FileText size={13} className="mr-1" aria-hidden="true" /> Cite</>}
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-bold text-lg truncate" title={document.title}>
            {document.title}
          </h2>
          <div className="text-xs text-muted-foreground flex gap-2 items-center mt-1">
            {document.favicon && <img src={document.favicon} alt="" className="w-3 h-3 rounded-md" />}
            {hostname ? (
              <span className="truncate">{hostname}</span>
            ) : (
              <span className="truncate font-mono text-[10px]">Local</span>
            )}
            <span>•</span>
            <span>{timeAgo(document.capturedAt)}</span>
          </div>
        </div>
        {hostname && (
          <a
            href={document.url}
            target="_blank"
            rel="noreferrer"
            className="p-2 hover:bg-muted transition-colors rounded-lg border-transparent hover:border-primary"
            title="Open original URL"
          >
            <ExternalLink className="w-5 h-5 text-muted-foreground" />
          </a>
        )}
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto p-6 bg-background">
        <div className="prose prose-sm dark:prose-invert max-w-none prose-img:rounded-md prose-img:border prose-img:border-border prose-headings:font-bold prose-a:text-primary prose-pre:rounded-md">
           <>
             {metadataCard}
             {renderContent()}
           </>
        </div>
      </div>
    </div>
  );
};
