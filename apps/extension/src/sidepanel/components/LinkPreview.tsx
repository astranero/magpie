import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { X, ExternalLink, Loader2, BookmarkPlus, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface LinkPreviewState {
  url: string;
  title?: string;
  markdown?: string;
  loading: boolean;
  error?: string;
  captured?: boolean;
  capturing?: boolean;
}

interface LinkPreviewProps {
  preview: LinkPreviewState;
  onClose: () => void;
  onCapture: () => void;
  /** Links inside the preview chain into a new preview — browse without leaving the panel. */
  onFollow: (url: string) => void;
}

/**
 * In-panel page preview. Clicking a link in chat or a document fetches the
 * target through the research scrape pipeline and shows it HERE — the user
 * never leaves the side panel. Nothing is stored unless they hit Capture.
 */
export const LinkPreview: React.FC<LinkPreviewProps> = ({ preview, onClose, onCapture, onFollow }) => {
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background animate-in fade-in slide-in-from-bottom-4 motion-reduce:animate-none">
      {/* Header — catalog card rule under the fetched page's identity */}
      <div className="card-rule-thin shrink-0 bg-card px-3.5 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground flex-1">
            Link preview — not saved
          </span>
          <button
            type="button"
            onClick={() => window.open(preview.url, '_blank')}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title="Open in browser tab"
            aria-label="Open in browser tab"
          >
            <ExternalLink size={13} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title="Close preview"
            aria-label="Close preview"
          >
            <X size={15} />
          </button>
        </div>
        <div className="mt-1 min-w-0">
          <div className="font-display text-[15px] leading-snug truncate">{preview.title || preview.url}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">{preview.url}</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3">
        {preview.loading ? (
          <div className="flex items-center justify-center gap-2 h-full text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none text-primary" aria-hidden="true" />
            Fetching page…
          </div>
        ) : preview.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {preview.error}
            <div className="mt-2 text-muted-foreground">
              Some sites block fetching — use the ↗ button above to open it in a browser tab instead.
            </div>
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-img:rounded-md prose-headings-display prose-a:text-primary">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
              urlTransform={(url) => url.startsWith('data:image/') ? url : defaultUrlTransform(url)}
              components={{
                a: ({ href, children, ...props }) => {
                  if (href && /^https?:\/\//i.test(href)) {
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) return; // modifier-click = real tab
                          e.preventDefault();
                          onFollow(href);
                        }}
                        title={`${href}\n\nClick: preview here · Cmd/Ctrl-click: open in browser`}
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
              {preview.markdown || ''}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Action bar */}
      {!preview.loading && !preview.error && (
        <div className="shrink-0 border-t border-border bg-card px-3.5 py-2.5 flex gap-2">
          <Button
            className="flex-1 h-8 text-xs font-semibold rounded-lg"
            onClick={onCapture}
            disabled={preview.capturing || preview.captured}
          >
            {preview.captured ? (
              <><Check size={13} className="mr-1.5" /> Captured to workspace</>
            ) : preview.capturing ? (
              <><Loader2 size={13} className="mr-1.5 animate-spin motion-reduce:animate-none" /> Capturing…</>
            ) : (
              <><BookmarkPlus size={13} className="mr-1.5" /> Capture to workspace</>
            )}
          </Button>
          <Button
            variant="ghost"
            className="h-8 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
      )}
    </div>
  );
};
