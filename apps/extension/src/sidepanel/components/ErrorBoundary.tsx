import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Compact fallback for small scopes (one chat message) vs the full-panel one. */
  compact?: boolean;
  /** Label shown in the fallback so the user knows what broke. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * A render error anywhere in React unmounts the whole tree — the user sees a
 * white panel with zero explanation. Boundaries convert that into a visible,
 * recoverable card: the app-level one keeps the panel alive, the per-message
 * one quarantines a single bad message (malformed markdown/KaTeX/etc.) so the
 * rest of the chat keeps rendering.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.compact) {
      return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          This {this.props.label || 'message'} failed to render ({error.message}).
          <button
            type="button"
            className="ml-2 underline underline-offset-2"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }

    return (
      <div className="h-screen w-full flex flex-col items-center justify-center gap-3 bg-background text-foreground p-6 text-center">
        <div className="font-display text-lg">Something broke while rendering.</div>
        <div className="text-xs text-muted-foreground max-w-[300px] break-words">
          {error.message}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg bg-primary text-primary-foreground text-xs font-semibold px-3 py-1.5"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded-lg border border-border text-xs font-medium px-3 py-1.5 text-muted-foreground"
            onClick={() => window.location.reload()}
          >
            Reload panel
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Your documents and chats are safe — this is only a display error.
        </div>
      </div>
    );
  }
}
