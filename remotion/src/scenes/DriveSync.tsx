import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Caption, useRise } from '../components/ui';
import { COLORS, FONT_DISPLAY, FONT_MONO } from '../theme';

// depth, label, isFolder — Magpie is the ROOT folder that holds every workspace.
const TREE: Array<[number, string, boolean]> = [
  [0, 'V-Strom research', true],
  [1, 'dl650-review.md', false],
  [1, 'owner-costs.md', false],
  [0, 'SaaS ideas', true],
  [1, 'reddit-1k-mrr.md', false],
];

export const DriveSync: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wrap = useRise(8);
  // sync arrows loop
  const t = (frame % 60) / 60;

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 80 }}>
        {/* local library */}
        <div style={{ ...wrap, width: 420, textAlign: 'center' }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.gold, letterSpacing: 2, marginBottom: 14 }}>ON YOUR DEVICE</div>
          <div style={{ background: COLORS.panel, borderRadius: 18, border: `1px solid ${COLORS.panelEdge}`, boxShadow: '0 30px 70px rgba(0,0,0,0.4)', padding: 26, textAlign: 'left' }}>
            {[COLORS.green, COLORS.blue, COLORS.gold].map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: c }} />
                <div style={{ flex: 1, height: 12, borderRadius: 6, background: COLORS.panelEdge }} />
              </div>
            ))}
            <div style={{ marginTop: 10, fontFamily: FONT_MONO, fontSize: 15, color: COLORS.muted }}>IndexedDB · encrypted-at-rest ready</div>
          </div>
        </div>

        {/* sync arrows */}
        <div style={{ position: 'relative', width: 120, height: 80 }}>
          {[0, 1].map((dir) => (
            <div key={dir} style={{ position: 'absolute', top: dir * 40, left: 0, width: '100%', fontSize: 34, color: dir === 0 ? COLORS.green : COLORS.blue, transform: `translateX(${interpolate(dir === 0 ? t : 1 - t, [0, 1], dir === 0 ? [-10, 20] : [20, -10])}px)`, textAlign: 'center' }}>
              {dir === 0 ? '⇢' : '⇠'}
            </div>
          ))}
        </div>

        {/* drive tree */}
        <div style={{ ...wrap, width: 440 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.gold, letterSpacing: 2, marginBottom: 14, textAlign: 'center' }}>GOOGLE DRIVE</div>
          <div style={{ background: COLORS.panel, borderRadius: 18, border: `1px solid ${COLORS.panelEdge}`, boxShadow: '0 30px 70px rgba(0,0,0,0.4)', padding: 22 }}>
            {/* breadcrumb */}
            <div style={{ fontFamily: FONT_MONO, fontSize: 14, color: COLORS.muted, marginBottom: 10 }}>My Drive ›</div>
            {/* ROOT folder — Magpie holds every workspace */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: COLORS.primaryWash, border: `1.5px solid ${COLORS.primary}` }}>
              <span style={{ fontSize: 22 }}>📁</span>
              <span style={{ fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, color: COLORS.ink }}>Magpie</span>
              <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 12, color: COLORS.primary, border: `1px solid ${COLORS.primary}`, borderRadius: 999, padding: '2px 9px' }}>root</span>
            </div>
            {/* nested workspaces, with a guide line to show containment */}
            <div style={{ marginLeft: 20, marginTop: 4, paddingLeft: 16, borderLeft: `2px solid ${COLORS.panelEdge}` }}>
              {TREE.map((row, i) => {
                const rowIn = spring({ frame: frame - (30 + i * 9), fps, config: { damping: 200 } });
                return (
                  <div key={i} style={{ paddingLeft: row[0] * 24, display: 'flex', alignItems: 'center', gap: 8, fontFamily: row[2] ? FONT_DISPLAY : FONT_MONO, fontSize: row[2] ? 21 : 17, color: row[2] ? COLORS.ink : COLORS.inkSoft, padding: '6px 0', opacity: rowIn, transform: `translateX(${interpolate(rowIn, [0, 1], [-12, 0])}px)` }}>
                    <span>{row[2] ? '📁' : '📄'}</span>{row[1]}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </AbsoluteFill>
      <Caption kicker="Two-way sync" title="Local-first — mirrored to Drive, one folder per workspace" />
    </Backdrop>
  );
};
