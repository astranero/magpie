import React, { useState, useRef, useEffect } from 'react';
import { LocalDocument } from '../types';
import { contentHasTag } from '../../lib/frontmatter';
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
}) => {
  const [showLore, setShowLore] = useState(false);

  // ── Library search: title filter (instant) + semantic search (debounced) ──
  interface SearchHit { id: string; title: string; snippet: string; anchorId: string; capturedAt: string }
  const [searchQuery, setSearchQuery] = useState('');
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
        setSearching(false);
        setSearchHits(Array.isArray(res?.results) ? res.results : []);
      });
    }, 350);
    return () => { if (searchTimer.current) window.clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const titleFilter = searchQuery.trim().toLowerCase();
  const docsToShow = (showLore ? globalDocuments : documents)
    .filter(d => !titleFilter || d.title.toLowerCase().includes(titleFilter));
  const projectDocIds = new Set(documents.map(d => d.id));

  // Machine-gathered research sources (a deep run captures dozens) collapse
  // into one group so they don't bury the user's own curated documents.
  const isResearchSource = (d: LocalDocument) => contentHasTag(d.content || '', 'research-source');
  const curatedDocs = docsToShow.filter(d => !isResearchSource(d));
  const researchSourceDocs = docsToShow.filter(isResearchSource);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Tab toggle — border-b-2 to match system standard */}
      <div className="flex gap-2 p-4 border-b border-border bg-card shrink-0">
        <Button
          variant={!showLore ? 'default' : 'secondary'}
          className="flex-1 h-8 text-xs"
          onClick={() => setShowLore(false)}
        >
          <BookOpen className="w-3.5 h-3.5 mr-1.5" /> Session Lore
        </Button>
        <Button
          variant={showLore ? 'default' : 'secondary'}
          className="flex-1 h-8 text-xs"
          onClick={() => setShowLore(true)}
        >
          <Library className="w-3.5 h-3.5 mr-1.5" /> Global Lore
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
            placeholder="Search your lore — titles instantly, contents semantically…"
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
                  className="group flex flex-col gap-3 p-3 rounded-lg border border-border bg-card text-card-foreground shadow-card hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {doc.favicon ? (
                      <img className="w-5 h-5 mt-0.5 object-contain shrink-0" src={doc.favicon} alt="" />
                    ) : (
                      <div className="w-5 h-5 mt-0.5 flex items-center justify-center text-muted-foreground shrink-0">
                        <FileText size={14} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {!showLore && (
                            <input
                              type="checkbox"
                              className="mt-0.5 w-3.5 h-3.5 border-input text-primary focus:ring-primary shrink-0"
                              checked={doc.enabled !== false}
                              onChange={(e) => toggleDoc(doc.id, e.target.checked)}
                              title={`Include \"${doc.title}\" in chat context`}
                              aria-label={`Include \"${doc.title}\" in chat context`}
                            />
                          )}
                          <button
                            className="flex items-center gap-1.5 hover:underline text-left min-w-0"
                            onClick={() => onDocumentClick(doc.id)}
                            title="Read Document"
                          >
                            <BookOpen className="w-3.5 h-3.5 text-primary shrink-0" />
                            <span className="truncate font-display text-[15px] leading-snug">{doc.title}</span>
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-muted-foreground">
                        <span className="tabular-nums">{doc.wordCount.toLocaleString()} words</span>
                        <span aria-hidden="true">·</span>
                        <span>{timeAgo(doc.capturedAt)}</span>
                        {doc.syncedToDrive && (
                          <>
                            <span>·</span>
                            <span title="Synced to Drive"><Cloud className="w-3 h-3 text-blue-400" /></span>
                          </>
                        )}
                      </div>
                      {doc.url && (
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
                          {doc.url}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {showLore ? (
                      isLinked ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground border-border"
                          onClick={() => unlinkDocument(doc.id)}
                          title="Remove from this workspace (document stays in library)"
                        >
                          <Minus size={12} className="mr-1" /> Unlink
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[10px] text-primary hover:bg-primary hover:text-primary-foreground border-primary/20"
                          onClick={() => linkDocument(doc.id)}
                          title="Add to this workspace"
                        >
                          <Plus size={12} className="mr-1" /> Add
                        </Button>
                      )
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground border-border"
                        onClick={() => unlinkDocument(doc.id)}
                        title="Remove from this workspace (document stays in library)"
                      >
                        <Minus size={12} className="mr-1" /> Unlink
                      </Button>
                    )}
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => onDocumentClick(doc.id)}
                      title="Read Document"
                      aria-label={`Read ${doc.title}`}
                    >
                      <BookOpen size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => downloadDoc(doc)}
                      title="Download as Markdown"
                      aria-label={`Download ${doc.title}`}
                    >
                      <Download size={14} />
                    </Button>
                    {doc.url && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground"
                        onClick={() => window.open(doc.url, '_blank')}
                        title="Open original source"
                        aria-label={`Open source for ${doc.title}`}
                      >
                        <ExternalLink size={14} />
                      </Button>
                    )}
                    {showLore && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => deleteDoc(doc.id)}
                        title="Permanently delete from library"
                        aria-label={`Permanently delete ${doc.title}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
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
