import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { COLORS, FONT_DISPLAY, FONT_SANS, FONT_MONO } from '../theme';

// ── motion helpers ───────────────────────────────────────────────
/** Ease-in fade + rise, delayed by `delay` frames. */
export const useRise = (delay = 0, dist = 24) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return {
    opacity: interpolate(s, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(s, [0, 1], [dist, 0])}px)`,
  } as React.CSSProperties;
};

/** Clamp a value to [0,1] progress over a frame window. */
export const prog = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

// ── backdrop ─────────────────────────────────────────────────────
export const Backdrop: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(1200px 800px at 20% -10%, ${COLORS.bgWash}, ${COLORS.bg} 60%)`,
      fontFamily: FONT_SANS,
    }}
  >
    {children}
  </AbsoluteFill>
);

// ── magpie mark (the real BrandMark: a magpie perched on an index card,
//    long upswept tail, catalog "rule" line — copied from the extension) ──
export const Magpie: React.FC<{ size?: number; color?: string; eye?: string }>
  = ({ size = 120, color = COLORS.ink, eye = COLORS.panel }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {/* index card */}
    <rect x="2" y="16.5" width="20" height="6" rx="1" stroke={color} strokeOpacity={0.4} strokeWidth={1.4} />
    {/* catalog rule on the card */}
    <line x1="4.5" y1="19" x2="19.5" y2="19" stroke={COLORS.rule} strokeWidth={1.4} strokeLinecap="round" />
    {/* magpie: round head, teardrop body, long upswept tail */}
    <path
      d="M6.2 10.2 C6.2 8.9 7.2 7.9 8.4 7.9 C9.3 7.9 10 8.4 10.4 9.1 L13 10.4 L21.2 4.6 C21.6 4.4 21.9 4.8 21.7 5.1 L14.6 12.2 C14.2 14 12.7 15.2 10.9 15.2 C8.8 15.2 7.1 13.7 6.9 11.7 L4.6 10.9 C4.3 10.8 4.3 10.4 4.6 10.3 Z"
      fill={color}
    />
    {/* legs */}
    <line x1="9.7" y1="15.2" x2="9.7" y2="16.5" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    <line x1="12" y1="14.9" x2="12.3" y2="16.5" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    {/* eye */}
    <circle cx="8.2" cy="9.6" r="0.7" fill={eye} />
  </svg>
);

// ── side-panel frame (the extension sidebar) ─────────────────────
export const SidePanel: React.FC<{
  title?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  width?: number;
}> = ({ title = 'Magpie', children, style, width = 640 }) => (
  <div
    style={{
      width,
      background: COLORS.panel,
      borderRadius: 22,
      boxShadow: '0 40px 90px rgba(0,0,0,0.45), 0 2px 0 rgba(255,255,255,0.5) inset',
      border: `1px solid ${COLORS.panelEdge}`,
      overflow: 'hidden',
      color: COLORS.ink,
      ...style,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '18px 24px',
        borderBottom: `1px solid ${COLORS.line}`,
        background: 'linear-gradient(180deg, #fff, transparent)',
      }}
    >
      <Magpie size={26} />
      <span style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600 }}>{title}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
        {[COLORS.green, COLORS.gold, COLORS.blue].map((c) => (
          <span key={c} style={{ width: 10, height: 10, borderRadius: 5, background: c, opacity: 0.7 }} />
        ))}
      </span>
    </div>
    <div style={{ padding: 20, background: '#EEF2F7' }}>{children}</div>
  </div>
);

// ── chat messages (the REAL layout: both left-aligned cards; the user card is
//    narrower with a squared bottom-left corner, the assistant card full-width) ──
export const Bubble: React.FC<{ who: 'user' | 'ai'; children: React.ReactNode; style?: React.CSSProperties }>
  = ({ who, children, style }) =>
  who === 'user' ? (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '85%',
        background: '#fff',
        border: `1px solid ${COLORS.panelEdge}`,
        borderRadius: 12,
        borderBottomLeftRadius: 4,
        padding: '12px 16px',
        fontSize: 19,
        lineHeight: 1.5,
        color: COLORS.ink,
        boxShadow: '0 1px 4px rgba(23,26,43,0.06)',
        ...style,
      }}
    >
      {children}
    </div>
  ) : (
    <div
      style={{
        alignSelf: 'stretch',
        width: '100%',
        background: '#fff',
        border: `1px solid ${COLORS.panelEdge}`,
        borderRadius: 14,
        padding: '16px 18px',
        fontSize: 20,
        lineHeight: 1.55,
        color: COLORS.ink,
        boxShadow: '0 1px 6px rgba(23,26,43,0.06)',
        ...style,
      }}
    >
      {children}
    </div>
  );

// citation chip
export const Cite: React.FC<{ n: number }> = ({ n }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22,
      height: 22,
      padding: '0 6px',
      margin: '0 3px',
      borderRadius: 6,
      background: COLORS.blueWash,
      border: `1px solid #BFD6E6`,
      color: COLORS.blue,
      fontSize: 14,
      fontWeight: 700,
      fontFamily: FONT_MONO,
      verticalAlign: 'middle',
    }}
  >
    {n}
  </span>
);

// pill (slash command / tag)
export const Pill: React.FC<{ children: React.ReactNode; tone?: 'green' | 'gold' | 'blue' | 'ink' }>
  = ({ children, tone = 'green' }) => {
  const map = { green: COLORS.green, gold: COLORS.gold, blue: COLORS.blue, ink: COLORS.inkSoft };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 12px',
        borderRadius: 999,
        background: '#fff',
        border: `1.5px solid ${map[tone]}`,
        color: map[tone],
        fontSize: 17,
        fontWeight: 600,
        fontFamily: FONT_MONO,
      }}
    >
      {children}
    </span>
  );
};

// ── typewriter ───────────────────────────────────────────────────
export const Typewriter: React.FC<{ text: string; start: number; cps?: number; style?: React.CSSProperties }>
  = ({ text, start, cps = 26, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shown = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  const out = text.slice(0, shown);
  const done = shown >= text.length;
  return (
    <span style={style}>
      {out}
      {!done && frame > start && (
        <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▌</span>
      )}
    </span>
  );
};

// ── scene caption (lower-third title) ────────────────────────────
export const Caption: React.FC<{ kicker: string; title: string; delay?: number }>
  = ({ kicker, title, delay = 6 }) => {
  const a = useRise(delay);
  return (
    <div style={{ position: 'absolute', left: 96, bottom: 84, ...a }}>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 20,
          letterSpacing: 3,
          textTransform: 'uppercase',
          color: COLORS.gold,
          marginBottom: 10,
        }}
      >
        {kicker}
      </div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 56, color: COLORS.panel, fontWeight: 600, maxWidth: 900 }}>
        {title}
      </div>
    </div>
  );
};

// ── fake cursor ──────────────────────────────────────────────────
export const Cursor: React.FC<{ x: number; y: number; press?: boolean }> = ({ x, y, press }) => (
  <div style={{ position: 'absolute', left: x, top: y, transform: `scale(${press ? 0.85 : 1})`, transition: 'transform 0.1s' }}>
    <svg width={34} height={34} viewBox="0 0 24 24">
      <path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z" fill="#fff" stroke={COLORS.ink} strokeWidth={1.5} />
    </svg>
  </div>
);
