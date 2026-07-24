import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Collapsible settings section. Open/closed state is remembered per-id in
 * localStorage so it survives panel reopen.
 *
 * Styled as a FLUSH ROW, not a card: a side panel is ~360px wide, and a stack
 * of rounded, shadowed, side-bordered cards spent that width on chrome and made
 * the panel read as a box floating inside the browser. Sections now run edge to
 * edge, separated by a single hairline — the pattern native sidebars use
 * (Chrome DevTools, VS Code, Finder).
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
    <section className="border-b border-border/70 last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        // Sticky: on a long settings list the section you're inside stays named
        // at the top of the viewport instead of scrolling away.
        className="sticky top-0 z-10 w-full flex items-start gap-2 px-4 py-3 text-left bg-background hover:bg-accent/50 transition-colors"
        aria-expanded={open}
      >
        <ChevronDown
          size={14}
          className={`shrink-0 mt-0.5 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className="min-w-0">
          <span className="block font-semibold text-sm leading-tight">{title}</span>
          {subtitle && <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{subtitle}</span>}
        </span>
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-4">{children}</div>}
    </section>
  );
};
