import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Caption, SidePanel, Bubble, Pill, Typewriter, useRise } from '../components/ui';
import { COLORS, FONT_MONO, FONT_SANS } from '../theme';

// /data is a normal chat turn: the user's message, a live status line while it
// gathers, then an AI bubble with a plain markdown answer (here, a table).
const ROWS = [
  ['2017 · 41 000 km', '5 290 €', 'nettimoto.com'],
  ['2015 · 33 500 km', '5 450 €', 'tori.fi'],
  ['2019 · 28 900 km', '6 400 €', 'nettimoto.com'],
];

const STATUS = [
  'Searching the web…',
  'nettimoto.com · reading search results…',
  'Fetched 3 listings · writing answer…',
];

export const DataAgent: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const q = useRise(8);
  // status runs ~24..120, then the answer bubble appears
  const statusIdx = Math.min(STATUS.length - 1, Math.floor((frame - 24) / 30));
  const answering = frame > 120;
  const ansIn = spring({ frame: frame - 120, fps, config: { damping: 200 } });

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <SidePanel width={760} title="Magpie · Chat">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 440 }}>
            {/* user message */}
            <div style={{ ...q, display: 'flex', flexDirection: 'column' }}>
              <Bubble who="user">
                <Pill tone="blue">/data</Pill>{' '}
                <span style={{ fontFamily: FONT_SANS }}>cheapest Suzuki DL650 on the market</span>
              </Bubble>
            </div>

            {/* live status line (like the real "phase · elapsed" line) */}
            {!answering && frame > 22 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 4px', color: COLORS.muted, fontFamily: FONT_MONO, fontSize: 17 }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: COLORS.primary, opacity: 0.4 + 0.6 * Math.abs(Math.sin(frame / 6)) }} />
                {STATUS[statusIdx]}
                <span style={{ marginLeft: 8, color: COLORS.muted, opacity: 0.7 }}>{((frame - 22) / fps).toFixed(0)}s</span>
              </div>
            )}

            {/* AI answer — plain markdown, with a table */}
            {answering && (
              <div style={{ opacity: ansIn, transform: `translateY(${interpolate(ansIn, [0, 1], [12, 0])}px)` }}>
                <Bubble who="ai" style={{ maxWidth: '100%', width: '100%' }}>
                  <div style={{ fontFamily: FONT_SANS, fontSize: 20, color: COLORS.ink, marginBottom: 12 }}>
                    <Typewriter text="Cheapest DL650 listings I could fetch, sorted by price:" start={124} cps={40} />
                  </div>
                  {/* markdown-style table, plain like the chat renders it */}
                  <div style={{ border: `1px solid ${COLORS.line}`, borderRadius: 8, overflow: 'hidden', fontFamily: FONT_SANS }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 0.8fr 1fr', padding: '9px 14px', background: COLORS.chip, fontSize: 15, fontWeight: 600, color: COLORS.inkSoft }}>
                      <span>Listing</span><span>Price</span><span>Source</span>
                    </div>
                    {ROWS.map((r, i) => {
                      const rowIn = spring({ frame: frame - (150 + i * 12), fps, config: { damping: 200 } });
                      return (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.5fr 0.8fr 1fr', padding: '11px 14px', borderTop: `1px solid ${COLORS.line}`, fontSize: 18, color: COLORS.ink, opacity: rowIn }}>
                          <span>{r[0]}</span>
                          <span style={{ fontWeight: 600 }}>{r[1]}</span>
                          <span style={{ color: COLORS.primary, textDecoration: 'underline' }}>{r[2]}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 12, fontSize: 15, color: COLORS.muted }}>
                    Credential-free · public data only. Reddit’s API 403’d, so I read the listing pages directly.
                  </div>
                </Bubble>
              </div>
            )}
          </div>
        </SidePanel>
      </AbsoluteFill>
      <Caption kicker="/data" title="A web-data agent — right in the chat" />
    </Backdrop>
  );
};
