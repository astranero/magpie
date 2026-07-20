import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LocalDocument } from '../types';
import { contentHasTag } from '../../lib/frontmatter';

// Machine-gathered research sources (a deep run captures dozens) collapse into
// one group so they don't bury the user's own curated docs. Pure + module-level
// so the derived-list useMemos below have stable deps.
const isResearchSource = (d: LocalDocument) => contentHasTag(d.content || '', 'research-source');
import { Download, ExternalLink, Trash2, Cloud, CloudDownload, Plus, Minus, Library, BookOpen, FileUp, FolderUp, FileText, Image, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MagpieEmptyIllustration } from './BrandMark';

interface LoreViewProps {
  documents: LocalDocument[];
  globalDocuments: LocalDocument[];
  authed: boolean;
  syncing: boolean;
  toggleDoc: (id: string, checked: boolean) => void;
  downloadDoc: (doc: LocalDocument) => void;
  deleteDoc: (id: string) => void;
  linkDocument: (id: string) => void;
  unlinkDocument: (id: string) => void;
  syncToDrive: () => void;
  importFromDrive: () => void;
  importing: boolean;
  importMarkdownFiles: () => void;
  importMarkdownFolder: () => void;
  importPdfFiles: () => void;
  importImageFiles: () => void;
  timeAgo: (iso: string) => string;
  onDocumentClick: (id: string, anchorId?: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export const LoreView: React.FC<LoreViewProps> = ({
  documents,
  globalDocuments,
  authed,
  syncing,
  toggleDoc,
  downloadDoc,
  deleteDoc,
  linkDocument,
  unlinkDocument,
  syncToDrive,
  importFromDrive,
  importing,
  importMarkdownFiles,
  importMarkdownFolder,
  importPdfFiles,
  importImageFiles,
  timeAgo,
  onDocumentClick,
  searchQuery,
  setSearchQuery,
}) => {
  const { t } = useTranslation();
  const [showLore, setShowLore] = useState(false);

  // ── Library search: title filter (instant) + semantic search (debounced) ──
  interface SearchHit { id: string; title: string; snippet: string; anchorId: string; capturedAt: string }
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (q.length < 3) { setSearchHits(null); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = window.setTimeout(() => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) { setSearching(false); return; }
      chrome.runtime.sendMessage({ action: 'SEARCH_LIBRARY', query: q }, (res: any) => {
        if (chrome.runtime.lastError) {
          setSearching(false); // previously missing → "Searching…" stuck forever
          return;
        }
        setSearching(false);
        setSearchHits(Array.isArray(res?.results) ? res.results : []);
      });
    }, 350);
    return () => { if (searchTimer.current) window.clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const titleFilter = searchQuery.trim().toLowerCase();

  // MEMOIZED — isResearchSource parses each doc's FULL content, so running the
  // filters on every render (a research run's dozens of large docs) locked the
  // main thread on unrelated re-renders (tab switch, progress toasts). Recompute
  // only when the docs or the filter actually change.
  const docsToShow = useMemo(() => {
    const list = showLore ? globalDocuments : documents;
    if (!titleFilter) return list;
    if (titleFilter.startsWith('tag:')) {
      const tagToMatch = titleFilter.slice(4).trim();
      return list.filter(d => {
        const contentLower = (d.content || '').toLowerCase();
        // Match standard YAML format tag lists, e.g., 'tags: [tag1, tag2]' or 'tags:\n  - tag1'
        return contentLower.includes(tagToMatch);
      });
    }
    return list.filter(d => d.title.toLowerCase().includes(titleFilter));
  }, [showLore, globalDocuments, documents, titleFilter]);

  const projectDocIds = useMemo(() => new Set(documents.map(d => d.id)), [documents]);
  const curatedDocs = useMemo(() => docsToShow.filter(d => !isResearchSource(d)), [docsToShow]);
  const researchSourceDocs = useMemo(() => docsToShow.filter(isResearchSource), [docsToShow]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Tab toggle — border-b-2 to match system standard */}
      <div className="flex gap-2 p-4 border-b border-border bg-card shrink-0">
        <Button
          variant={!showLore ? 'default' : 'secondary'}
          className="flex-1 h-8 text-xs"
          onClick={() => setShowLore(false)}
        >
          <BookOpen className="w-3.5 h-3.5 mr-1.5" /> {t('lore.workspace')}
        </Button>
        <Button
          variant={showLore ? 'default' : 'secondary'}
          className="flex-1 h-8 text-xs"
          onClick={() => setShowLore(true)}
        >
          <Library className="w-3.5 h-3.5 mr-1.5" /> {t('lore.globalLore')}
        </Button>
      </div>

      {/* Library search — title filter + semantic content search */}
      <div className="px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="relative flex items-center">
          <Search size={13} className="absolute left-2.5 text-muted-foreground pointer-events-none" aria-hidden="true" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('lore.search')}
            className="w-full h-8 rounded-md border border-border bg-background pl-8 pr-7 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:border-primary"
            aria-label="Search library"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>
        {searchQuery.trim().length >= 3 && (
          <div className="mt-2 space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">
              {searching ? 'Searching contents…' : `Content matches ${searchHits ? `(${searchHits.length})` : ''}`}
            </div>
            {!searching && searchHits && searchHits.length === 0 && (
              <div className="text-[10px] font-mono text-muted-foreground">Nothing relevant in document contents — titles above still filter.</div>
            )}
            {!searching && (searchHits || []).map(hit => (
              <button
                key={hit.id}
                type="button"
                onClick={() => onDocumentClick(hit.id, hit.anchorId)}
                className="w-full text-left rounded-md border border-border bg-background hover:border-primary/50 transition-colors p-2"
                title="Open at the matching passage"
              >
                <div className="text-xs font-mono font-bold truncate">{hit.title}</div>
                <div className="text-[10px] text-muted-foreground leading-snug line-clamp-2">…{hit.snippet}…</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Local import tools — collapsible */}
      {!showLore && (
        <details
          className="border-b border-border bg-card shrink-0"
          open={typeof localStorage === 'undefined' || localStorage.getItem('magpie-section-import') !== 'false'}
          onToggle={(e) => {
            try {
              localStorage.setItem('magpie-section-import', String((e.target as HTMLDetailsElement).open));
            } catch {
              /* ignore */
            }
          }}
        >
          <summary className="px-4 py-1.5 text-xs font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground">
            Import Tools
          </summary>
          <div className="flex gap-2 px-4 pb-2">
            <Button
              variant="outline"
              className="flex-1 h-7 text-[10px] rounded-lg font-medium"
              onClick={importMarkdownFiles}
              disabled={importing}
              title="Import local .md files"
            >
              <FileUp className="w-3 h-3 mr-1.5" /> {importing ? 'Importing…' : 'Import .md'}
            </Button>
            <Button
              variant="outline"
              className="flex-1 h-7 text-[10px] rounded-lg font-medium"
              onClick={importMarkdownFolder}
              disabled={importing}
              title="Import a folder of .md files — relative images are embedded"
            >
              <FolderUp className="w-3 h-3 mr-1.5" /> {importing ? 'Importing…' : 'Folder'}
            </Button>
            <Button
              variant="outline"
              className="flex-1 h-7 text-[10px] rounded-lg font-medium"
              onClick={importPdfFiles}
              disabled={importing}
              title="Import PDFs — text extracted by code, scanned pages read by vision model"
            >
              <FileText className="w-3 h-3 mr-1.5" /> PDF
            </Button>
            <Button
              variant="outline"
              className="flex-1 h-7 text-[10px] rounded-lg font-medium"
              onClick={importImageFiles}
              disabled={importing}
              title="Import images — read into text with the vision model"
            >
              <Image className="w-3 h-3 mr-1.5" /> Image
            </Button>
          </div>
        </details>
      )}

      <div className="flex-1 overflow-y-auto no-scrollbar p-4">
        {docsToShow.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-4">
            <MagpieEmptyIllustration size={84} className="text-muted-foreground" />
            {showLore ? (
              <div className="space-y-1.5">
                <div className="font-display text-lg text-foreground">Your Lore is empty</div>
                <p className="text-xs text-muted-foreground leading-relaxed max-w-[240px]">
                  Everything you capture — pages, PDFs, transcripts — lands here, ready to search and cite.
                  Start with <strong>Capture</strong>, or import files above.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="font-display text-lg text-foreground">Nothing collected here yet</div>
                <p className="text-xs text-muted-foreground leading-relaxed max-w-[240px]">
                  <strong>Capture</strong> the page you're reading, or pull existing cards in from
                  Global Lore — in chat, <code className="text-primary">/recall &lt;topic&gt;</code> does it for you.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {curatedDocs.map(doc => {
              const isLinked = projectDocIds.has(doc.id);
              return (
                <div
                  key={doc.id}
                  className={`group relative flex flex-col gap-1.5 p-2.5 rounded-lg border transition-all duration-200 ${
                    doc.enabled !== false
                      ? 'border-primary/20 bg-primary/[0.01] shadow-sm'
                      : 'border-border bg-card/40 opacity-80 hover:opacity-100'
                  } hover:border-primary/35 hover:shadow-sm`}
                >
                  {/* Top Line: Icon + Title + Toggle */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    {doc.favicon ? (
                      <img className="w-5 h-5 object-contain rounded shrink-0 bg-background p-0.5 shadow-sm" src={doc.favicon} alt="" />
                    ) : (
                      <div className="w-5 h-5 flex items-center justify-center rounded bg-muted text-muted-foreground shrink-0 shadow-sm">
                        <FileText size={11} />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <button
                        className="group/btn text-left hover:text-primary transition-colors w-full min-w-0"
                        onClick={() => onDocumentClick(doc.id)}
                        title="Read Document"
                      >
                        <span className="block font-semibold text-xs text-foreground leading-tight group-hover/btn:underline break-words">
                          {doc.title}
                        </span>
                      </button>
                    </div>

                    {/* Custom Switch Toggle */}
                    {!showLore && (
                      <div className="flex items-center gap-1.5 shrink-0 self-center" title={doc.enabled !== false ? "Active in Chat" : "Muted in Chat"}>
                        <span className={`text-[8px] font-bold uppercase tracking-wider ${doc.enabled !== false ? 'text-primary/75' : 'text-muted-foreground/50'}`}>
                          {doc.enabled !== false ? 'Active' : 'Muted'}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={doc.enabled !== false}
                          onClick={() => toggleDoc(doc.id, doc.enabled === false)}
                          className={`relative inline-flex h-3.5 w-6 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${
                            doc.enabled !== false ? 'bg-primary' : 'bg-border'
                          }`}
                        >
                          <span
                            className={`pointer-events-none block h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-transform duration-200 ease-in-out ${
                              doc.enabled !== false ? 'translate-x-3' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Bottom Line: Metadata OR Action buttons on hover */}
                  <div className="flex items-center justify-between min-h-[20px] text-[10px] text-muted-foreground/75 font-mono">
                    {/* Left: Metadata */}
                    <div className="flex items-center gap-1.5 truncate mr-2">
                      <span className="bg-muted px-1 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wide">
                        {doc.wordCount.toLocaleString()}w
                      </span>
                      <span>•</span>
                      <span>{timeAgo(doc.capturedAt)}</span>
                      {doc.url && (
                        <>
                          <span>•</span>
                          <span className="truncate max-w-[120px]" title={doc.url}>
                            {doc.url.replace(/^https?:\/\/(www\.)?/, '')}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Right: Actions (Visible on group-hover OR focus-within for keyboard) */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 shrink-0">
                      {showLore ? (
                        isLinked ? (
                          <button
                            className="h-5 px-1.5 text-[9px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground border border-border rounded transition-colors flex items-center gap-0.5"
                            onClick={() => unlinkDocument(doc.id)}
                            title="Remove from Workspace"
                          >
                            <Minus size={9} /> Unlink
                          </button>
                        ) : (
                          <button
                            className="h-5 px-1.5 text-[9px] font-semibold text-primary hover:bg-primary hover:text-primary-foreground border border-primary/20 rounded transition-colors flex items-center gap-0.5"
                            onClick={() => linkDocument(doc.id)}
                            title="Add to Workspace"
                          >
                            <Plus size={9} /> Add
                          </button>
                        )
                      ) : (
                        <button
                          className="h-5 px-1.5 text-[9px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground border border-border rounded transition-colors flex items-center gap-0.5"
                          onClick={() => unlinkDocument(doc.id)}
                          title="Remove from Workspace"
                        >
                          <Minus size={9} /> Unlink
                        </button>
                      )}

                      <button
                        className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                        onClick={() => onDocumentClick(doc.id)}
                        title="Read full document text"
                      >
                        <BookOpen size={10} />
                      </button>

                      <button
                        className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                        onClick={() => downloadDoc(doc)}
                        title="Export as Markdown"
                      >
                        <Download size={10} />
                      </button>

                      {doc.url && (
                        <button
                          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                          onClick={() => window.open(doc.url, '_blank')}
                          title="Open original source"
                        >
                          <ExternalLink size={10} />
                        </button>
                      )}

                      {showLore && (
                        <button
                          className="h-5 w-5 flex items-center justify-center text-destructive hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                          onClick={() => deleteDoc(doc.id)}
                          title="Permanently delete from library"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                  </div>
                </div>
              </div>
            );
          })}

            {/* Machine-gathered research sources — compact, collapsed group */}
            {researchSourceDocs.length > 0 && (
              <details className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                <summary className="card-rule-thin px-3.5 py-2 text-[11px] font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground">
                  Research sources ({researchSourceDocs.length})
                </summary>
                <div className="p-1.5 space-y-0.5 max-h-72 overflow-y-auto no-scrollbar">
                  {researchSourceDocs.map(doc => (
                    <div key={doc.id} className="group/row flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent transition-colors">
                      {doc.favicon ? (
                        <img className="w-3.5 h-3.5 object-contain shrink-0" src={doc.favicon} alt="" />
                      ) : (
                        <FileText size={12} className="text-muted-foreground shrink-0" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left text-xs truncate hover:underline"
                        onClick={() => onDocumentClick(doc.id)}
                        title={doc.title}
                      >
                        {doc.title}
                      </button>
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0 tabular-nums">
                        {doc.wordCount.toLocaleString()}w
                      </span>
                      {doc.url && (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground shrink-0 opacity-0 group-hover/row:opacity-100 focus:opacity-100 transition-opacity"
                          onClick={() => window.open(doc.url, '_blank')}
                          title="Open original source"
                          aria-label={`Open source for ${doc.title}`}
                        >
                          <ExternalLink size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {authed && documents.length > 0 && (
        <div className="flex items-center justify-between p-3 border-t border-border bg-card shrink-0">
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={syncToDrive} disabled={syncing}>
            {syncing ? 'Syncing' : <><Cloud size={14} className="mr-1.5" /> Sync to Drive</>}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={importFromDrive} disabled={syncing}>
            <CloudDownload size={14} className="mr-1.5" /> Import from Drive
          </Button>
        </div>
      )}


    </div>
  );
};
