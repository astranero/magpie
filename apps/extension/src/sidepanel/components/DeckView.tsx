import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, RotateCcw, Shuffle, Check, RefreshCw, ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';
import { Flashcard } from '../types';

// ─────────────────────────────────────────────
// Flashcard deck player
// ─────────────────────────────────────────────
// A full-panel study player launched from a /flashcard message. Click (or Space)
// flips the card; "Got it" retires it for this round, "Again" recycles it to the
// back so weak cards keep coming back. Back returns to chat — the chat view stays
// mounted underneath, so the user lands on the same scroll spot.

interface DeckViewProps {
  title: string;
  cards: Flashcard[];
  onBack: () => void;
}

export const DeckView: React.FC<DeckViewProps> = ({ title, cards, onBack }) => {
  // The working queue of indices for this round; "Again" pushes to the back,
  // "Got it" drops it. Reset rebuilds it from the full deck.
  const [queue, setQueue] = useState<number[]>(() => cards.map((_, i) => i));
  const [flipped, setFlipped] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());

  const current = queue[0];
  const card = current != null ? cards[current] : null;
  const done = queue.length === 0;

  const reset = useCallback((shuffle = false) => {
    let order = cards.map((_, i) => i);
    if (shuffle) {
      // Fisher–Yates. Math.random is fine in the UI (workflow-script ban doesn't apply).
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    setQueue(order);
    setKnown(new Set());
    setFlipped(false);
    setShowHint(false);
  }, [cards]);

  const advance = useCallback((gotIt: boolean) => {
    setQueue(prev => {
      if (prev.length === 0) return prev;
      const [head, ...rest] = prev;
      if (gotIt) { setKnown(k => new Set(k).add(head)); return rest; }
      return [...rest, head]; // recycle to the back
    });
    setFlipped(false);
    setShowHint(false);
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    setQueue(prev => {
      if (prev.length < 2) return prev;
      return dir === 1 ? [...prev.slice(1), prev[0]] : [prev[prev.length - 1], ...prev.slice(0, -1)];
    });
    setFlipped(false);
    setShowHint(false);
  }, []);

  // Keyboard: Space/Enter flip, ←/→ navigate, 1=Again 2=Got it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFlipped(f => !f); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); flipped ? advance(true) : step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === '1' && flipped) { e.preventDefault(); advance(false); }
      else if (e.key === '2' && flipped) { e.preventDefault(); advance(true); }
      else if (e.key === 'Escape') { e.preventDefault(); onBack(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flipped, advance, step, onBack]);

  const pct = cards.length ? Math.round((known.size / cards.length) * 100) : 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <button
          type="button" onClick={onBack}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground rounded-lg px-2 py-1 hover:bg-accent transition-colors"
          title="Back to chat (Esc)"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" title={title}>{title}</div>
          <div className="h-1 mt-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{known.size}/{cards.length}</span>
      </div>

      {/* Card area */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-4 gap-4">
        {done ? (
          <div className="text-center space-y-3">
            <div className="text-4xl">🎉</div>
            <div className="text-lg font-semibold">Deck complete</div>
            <div className="text-sm text-muted-foreground">You got through all {cards.length} cards.</div>
            <div className="flex gap-2 justify-center pt-2">
              <button type="button" onClick={() => reset(false)} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-primary text-primary-foreground">
                <RotateCcw size={13} /> Study again
              </button>
              <button type="button" onClick={() => reset(true)} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-border hover:bg-accent">
                <Shuffle size={13} /> Shuffle
              </button>
            </div>
          </div>
        ) : card && (
          <>
            <button
              type="button" onClick={() => setFlipped(f => !f)}
              className="w-full max-w-md min-h-[220px] rounded-2xl border border-border bg-card shadow-card p-6 flex flex-col items-center justify-center text-center transition-transform active:scale-[0.99] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={flipped ? 'Answer — click to see the question' : 'Question — click to reveal the answer'}
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">{flipped ? 'Answer' : 'Question'}</span>
              <span className={`${flipped ? 'text-[15px] leading-relaxed' : 'text-lg font-medium'} text-foreground whitespace-pre-wrap`}>
                {flipped ? card.back : card.front}
              </span>
              {!flipped && showHint && card.hint && (
                <span className="mt-3 text-xs text-muted-foreground italic">💡 {card.hint}</span>
              )}
            </button>

            {/* Under-card controls */}
            {!flipped ? (
              <div className="flex items-center gap-2">
                {card.hint && !showHint && (
                  <button type="button" onClick={() => setShowHint(true)} className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-accent">
                    <Lightbulb size={12} /> Hint
                  </button>
                )}
                <button type="button" onClick={() => setFlipped(true)} className="text-[11px] font-medium px-3 py-1.5 rounded-full bg-primary text-primary-foreground">
                  Show answer
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => advance(false)} className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-1.5 rounded-full border border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10">
                  <RefreshCw size={13} /> Again
                </button>
                <button type="button" onClick={() => advance(true)} className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-1.5 rounded-full bg-emerald-600 text-white hover:bg-emerald-700">
                  <Check size={13} /> Got it
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer nav */}
      {!done && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
          <button type="button" onClick={() => step(-1)} disabled={queue.length < 2} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 px-2 py-1 rounded-lg hover:bg-accent">
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-[11px] text-muted-foreground tabular-nums">{queue.length} left</span>
          <button type="button" onClick={() => step(1)} disabled={queue.length < 2} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 px-2 py-1 rounded-lg hover:bg-accent">
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
};
