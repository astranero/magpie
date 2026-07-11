import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Minimal collapsible section for the side panel. Open/closed state is
 * remembered per-id in localStorage so it survives panel reopen.
 */
export const Section: React.FC<{
  id: string;
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ id, title, subtitle, defaultOpen = true, children }) => {
  const storageKey = `ara-section-${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === null ? defaultOpen : saved === 'true';
    } catch {
      return defaultOpen;
    }
  });

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* private mode */ }
  };

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-card overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="card-rule w-full flex items-center justify-between p-4 text-left hover:bg-accent/60 transition-colors"
        aria-expanded={open}
      >
        <div>
          <h3 className="font-bold font-mono tracking-widest uppercase text-sm">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-1 font-mono uppercase">{subtitle}</p>}
        </div>
        <ChevronDown size={16} className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="p-4 space-y-4">{children}</div>}
    </div>
  );
};
