import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Search, X, Check, FolderDown } from 'lucide-react';

export interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  alreadyImported?: boolean;
}

/**
 * Choose which Drive files to import.
 *
 * Import used to be a single button that pulled in whatever the folder listing
 * returned — and that listing was truncated to one page, so with a large folder
 * it appeared to pick files at random. Pagination fixed *which* files are
 * offered; this dialog fixes the other half of the complaint, which is that the
 * user was never asked.
 *
 * Files already in the library are listed but not selectable. Hiding them would
 * make the count disagree with what the user can see in Drive; showing them as
 * selectable would promise an import that the de-duplicator then skips.
 */
export const DriveImportDialog: React.FC<{
  files: DriveFile[];
  onCancel: () => void;
  onImport: (fileIds: string[]) => void;
}> = ({ files, onCancel, onImport }) => {
  const importable = useMemo(() => files.filter(f => !f.alreadyImported), [files]);
  // Start with NOTHING selected. Pre-selecting everything made "Importing 0/2"
  // appear after the user thought they'd picked one — the count reflected a
  // default they never made. "Select all" is one click away for the bulk case.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter(f => f.name.toLowerCase().includes(q)) : files;
    // Importable first: the disabled rows are reference, not the task.
    return [...list].sort((a, b) => Number(!!a.alreadyImported) - Number(!!b.alreadyImported));
  }, [files, query]);

  const shownImportable = shown.filter(f => !f.alreadyImported);
  const allShownSelected = shownImportable.length > 0 && shownImportable.every(f => selected.has(f.id));

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllShown = () => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const f of shownImportable) {
        if (allShownSelected) next.delete(f.id); else next.add(f.id);
      }
      return next;
    });
  };

  const alreadyCount = files.length - importable.length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="Import from Drive">
      <div className="flex items-start gap-2 px-4 py-3 border-b border-border">
        <FolderDown size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight">Import from Drive</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
            {importable.length} available
            {alreadyCount > 0 && ` · ${alreadyCount} already in your library`}
          </p>
        </div>
        <button
          type="button" onClick={onCancel} aria-label="Close"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by name…"
            dir="auto"
            className="w-full h-8 pl-7 pr-2 text-xs rounded-md border border-input bg-card focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button" onClick={toggleAllShown} disabled={shownImportable.length === 0}
            className="text-[11px] text-primary hover:underline disabled:opacity-40 disabled:no-underline"
          >
            {allShownSelected ? 'Clear' : 'Select'} {query ? 'shown' : 'all'} ({shownImportable.length})
          </button>
          <span className="text-[11px] text-muted-foreground tabular-nums">{selected.size} selected</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar">
        {shown.length === 0 && (
          <p className="px-4 py-6 text-xs text-muted-foreground text-center">
            {files.length === 0 ? 'No Markdown files found in your Drive folder.' : 'Nothing matches that filter.'}
          </p>
        )}
        {shown.map(f => {
          const done = !!f.alreadyImported;
          const on = selected.has(f.id);
          return (
            <label
              key={f.id}
              className={`flex items-center gap-2.5 px-4 py-2 border-b border-border/50 last:border-b-0 ${
                done ? 'opacity-50' : 'cursor-pointer hover:bg-accent/50'
              }`}
            >
              <input
                type="checkbox" checked={on} disabled={done} onChange={() => toggle(f.id)}
                className="shrink-0 h-3.5 w-3.5 accent-primary"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs truncate" dir="auto">{f.name.replace(/\.md$/i, '')}</span>
                {f.createdTime && (
                  <span className="block text-[10px] text-muted-foreground font-mono">
                    {new Date(f.createdTime).toLocaleDateString()}
                  </span>
                )}
              </span>
              {done && (
                <span className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Check size={10} /> in library
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
        <Button variant="ghost" size="sm" className="flex-1 h-8 text-xs" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm" className="flex-1 h-8 text-xs"
          disabled={selected.size === 0}
          onClick={() => onImport([...selected])}
        >
          Import {selected.size > 0 ? selected.size : ''}
        </Button>
      </div>
    </div>
  );
};
