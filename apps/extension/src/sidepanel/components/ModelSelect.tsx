import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

// ─────────────────────────────────────────────
// ModelSelect — THE model picker
// ─────────────────────────────────────────────
// Every place a model is chosen (chat header, Settings main/vision/fast,
// Copilot section) renders this one component, so selection behaves and looks
// the same everywhere: a trigger button, a search box that is ALWAYS there
// (catalogs run to hundreds of entries), grouped results, keyboard nav.
// Divergent hand-rolled <Select>s were how the provider pickers drifted apart
// in the first place.

export interface ModelEntry {
  model: string;
  /** Group header, e.g. "GitHub Copilot" or "openrouter.ai · your API key". */
  group?: string;
  /** Carried through to onSelect untouched (e.g. provider discriminator). */
  meta?: unknown;
}

interface ModelSelectProps {
  entries: ModelEntry[];
  value: string;
  onSelect: (entry: ModelEntry) => void;
  placeholder?: string;
  /** Free-text entry for providers with no /models endpoint. */
  allowCustom?: boolean;
  /** Compact trigger for the chat header. */
  compact?: boolean;
  /** 'field' = full-width form control (Settings). 'pill' = rounded chip
   *  trigger sized to its content (chat header, inline placements). The
   *  dropdown panel — search, grouping, keyboard nav — is identical either
   *  way; only the closed-state trigger differs. */
  variant?: 'field' | 'pill';
  /** Pretty display name — shown as the primary line in the trigger and each
   *  option; the raw model id renders as a secondary line so a human-friendly
   *  label never hides which exact id is active. Omit for raw-id-only. */
  formatLabel?: (model: string) => string;
  /** Small tag rendered before the label, e.g. a "Copilot" chip. */
  badge?: (entry: ModelEntry) => React.ReactNode;
  /** Rendered below the option list, e.g. a "Refresh models" action. */
  footer?: React.ReactNode;
  'aria-label'?: string;
}

/** Pure so it's unit-testable: case-insensitive substring on model AND group. */
export function filterModelEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(e =>
    e.model.toLowerCase().includes(q) || (e.group || '').toLowerCase().includes(q));
}

export const ModelSelect: React.FC<ModelSelectProps> = ({
  entries, value, onSelect, placeholder = 'Select a model…', allowCustom = false, compact = false,
  variant = 'field', formatLabel, badge, footer,
  'aria-label': ariaLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterModelEntries(entries, query), [entries, query]);
  const customEntry: ModelEntry | null =
    allowCustom && query.trim() && !filtered.some(e => e.model === query.trim())
      ? { model: query.trim(), group: 'Custom id' }
      : null;
  const options = customEntry ? [...filtered, customEntry] : filtered;

  useEffect(() => { if (open) { setQuery(''); setActive(0); setTimeout(() => searchRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);

  // Close on outside click — the panel overlays other controls.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (e: ModelEntry) => { setOpen(false); onSelect(e); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) pick(options[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Render grouped: a header row whenever the group changes.
  let lastGroup: string | undefined;
  const activeEntry = entries.find(e => e.model === value);
  const displayLabel = value ? (formatLabel ? formatLabel(value) : value) : '';

  return (
    <div ref={rootRef} className={`relative ${variant === 'pill' ? 'inline-block' : 'w-full'}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel || placeholder}
        onClick={() => setOpen(o => !o)}
        className={variant === 'pill'
          ? 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border bg-card hover:bg-accent text-xs font-semibold text-foreground shadow-sm transition-colors'
          : `w-full flex items-center justify-between gap-2 rounded-lg border border-border bg-background text-left font-mono ${compact ? 'h-7 px-2 text-[11px]' : 'h-9 px-3 text-xs'} hover:border-primary/50 focus:outline-none focus:border-primary transition-colors`}
      >
        {variant === 'pill' && badge && activeEntry && badge(activeEntry)}
        <span className={`truncate ${variant === 'pill' ? 'max-w-[130px] font-sans font-semibold' : value ? 'text-foreground' : 'text-muted-foreground'}`}>
          {displayLabel || placeholder}
        </span>
        <ChevronDown size={variant === 'pill' || compact ? 11 : 14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      {open && (
        <div className={`absolute z-50 rounded-lg border border-border bg-popover shadow-lg ${variant === 'pill' ? 'bottom-full left-0 mb-1.5 w-64' : 'mt-1 w-full min-w-[220px]'}`} onKeyDown={onKeyDown}>
          <div className="relative flex items-center border-b border-border">
            <Search size={12} className="absolute left-2.5 text-muted-foreground pointer-events-none" aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Search ${entries.length} models…`}
              aria-label="Search models"
              className="w-full h-8 bg-transparent pl-8 pr-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {options.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted-foreground font-mono">No models match.</div>
            )}
            {options.map((e, i) => {
              const header = e.group !== lastGroup ? e.group : undefined;
              lastGroup = e.group;
              return (
                <React.Fragment key={`${e.group ?? ''}::${e.model}`}>
                  {header && (
                    <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{header}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={e.model === value}
                    data-active={i === active || undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(e)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${i === active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'}`}
                  >
                    {!formatLabel && <span className="w-3 shrink-0">{e.model === value && <Check size={12} aria-hidden="true" />}</span>}
                    {badge?.(e)}
                    {formatLabel ? (
                      <span className="truncate flex flex-col items-start gap-0.5 min-w-0">
                        <span className="font-sans font-semibold text-xs leading-none truncate w-full">{formatLabel(e.model)}</span>
                        <span className={`font-mono text-[9px] truncate w-full ${i === active ? 'text-primary/70' : 'text-muted-foreground/60'}`}>{e.model}</span>
                      </span>
                    ) : (
                      <span className="truncate font-mono">{e.model}</span>
                    )}
                    {e.model === value && <span className="ml-auto text-[9px] uppercase font-sans shrink-0 text-muted-foreground">Active</span>}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
};
