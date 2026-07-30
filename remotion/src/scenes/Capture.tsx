import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Caption, useRise, prog } from '../components/ui';
import { COLORS, FONT_DISPLAY, FONT_MONO, FONT_SANS } from '../theme';

// A web page (left) → one click → a clean .md card lands in the library (right).
export const Capture: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const pageIn = useRise(6);
  // capture pulse around frame 70; card flies in after
  const click = spring({ frame: frame - 66, fps, config: { damping: 12 } });
  const fly = spring({ frame: frame - 84, fps, config: { damping: 18 } });
  const flyX = interpolate(fly, [0, 1], [-260, 0]);
  const flyO = interpolate(fly, [0, 1], [0, 1]);
  const embed = prog(frame, 150, 200);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 60, flexDirection: 'row' }}>
        {/* source web page */}
        <div style={{ ...pageIn, width: 620, height: 520, background: '#fff', borderRadius: 16, border: `1px solid ${COLORS.line}`, boxShadow: '0 30px 70px rgba(0,0,0,0.4)', overflow: 'hidden' }}>
          <div style={{ height: 46, background: '#F1ECE2', display: 'flex', alignItems: 'center', paddingLeft: 16, gap: 8 }}>
            {['#E4776B', '#E9B84B', '#7FB77E'].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />)}
            <div style={{ marginLeft: 14, fontFamily: FONT_MONO, fontSize: 15, color: COLORS.muted }}>nettimoto.com/…/suzuki-dl650</div>
          </div>
          <div style={{ padding: 28 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 30, color: COLORS.ink, marginBottom: 14 }}>Suzuki DL650 V-Strom — 2019</div>
            {[92, 78, 85, 70, 88, 60].map((w, i) => (
              <div key={i} style={{ height: 12, width: `${w}%`, background: COLORS.panelEdge, borderRadius: 6, margin: '12px 0' }} />
            ))}
            <div style={{ marginTop: 20, display: 'inline-flex', gap: 10 }}>
              <span style={{ padding: '6px 12px', background: COLORS.greenWash, borderRadius: 8, fontSize: 15, color: COLORS.green }}>28 900 km</span>
              <span style={{ padding: '6px 12px', background: COLORS.greenWash, borderRadius: 8, fontSize: 15, color: COLORS.green }}>6 400 €</span>
            </div>
          </div>
          {/* capture pulse */}
          <div style={{ position: 'absolute', right: 26, top: 70, width: 56, height: 56 }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: 28, background: COLORS.green, opacity: interpolate(click, [0, 1, 1.6], [0, 0.4, 0], { extrapolateRight: 'clamp' }), transform: `scale(${1 + click * 1.4})` }} />
            <div style={{ position: 'absolute', inset: 8, borderRadius: 20, background: COLORS.green, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 22, transform: `scale(${interpolate(click, [0, 1], [1, 0.88])})` }}>✦</div>
          </div>
        </div>

        {/* captured markdown card */}
        <div style={{ transform: `translateX(${flyX}px)`, opacity: flyO, width: 520, background: COLORS.panel, borderRadius: 16, border: `1px solid ${COLORS.panelEdge}`, boxShadow: '0 30px 70px rgba(0,0,0,0.4)', padding: 26, fontFamily: FONT_SANS }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 15, color: COLORS.gold, letterSpacing: 2 }}>SAVED · MARKDOWN</span>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.inkSoft, lineHeight: 1.7 }}>
            <div style={{ color: COLORS.green }}>---</div>
            <div>title: Suzuki DL650 V-Strom</div>
            <div>source: nettimoto.com/…</div>
            <div>price: 6400 · km: 28900</div>
            <div style={{ color: COLORS.green }}>---</div>
            <div style={{ marginTop: 10, color: COLORS.ink }}># Seller's description</div>
            <div style={{ color: COLORS.inkSoft }}>Well maintained, service book, new tyres…</div>
          </div>
          {/* embedding chips */}
          <div style={{ marginTop: 18, display: 'flex', gap: 8, opacity: embed }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ width: 40, height: 14, borderRadius: 7, background: `linear-gradient(90deg, ${COLORS.blue}, ${COLORS.green})`, opacity: 0.5 + 0.1 * i }} />
            ))}
            <span style={{ fontSize: 14, color: COLORS.muted, marginLeft: 6 }}>indexed on-device</span>
          </div>
        </div>
      </AbsoluteFill>
      <Caption kicker="Capture" title="One click saves any page as clean Markdown" />
    </Backdrop>
  );
};
