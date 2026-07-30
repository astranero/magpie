import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Backdrop, Caption, useRise } from '../components/ui';
import { COLORS, FONT_DISPLAY, FONT_MONO, FONT_SANS } from '../theme';

// A single card flips front→back; a small stack + progress hint the deck.
export const Flashcard: React.FC = () => {
  const frame = useCurrentFrame();
  const wrap = useRise(8);
  // flip window 90..120
  const flip = interpolate(frame, [90, 120], [0, 180], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const showBack = flip > 90;
  const progress = interpolate(frame, [0, 240], [0.25, 0.6]);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...wrap, position: 'relative', width: 720, height: 420 }}>
          {/* stacked shadows */}
          <div style={{ position: 'absolute', inset: 0, transform: 'translateY(26px) scale(0.94)', background: COLORS.panel, borderRadius: 22, opacity: 0.5, border: `1px solid ${COLORS.panelEdge}` }} />
          <div style={{ position: 'absolute', inset: 0, transform: 'translateY(13px) scale(0.97)', background: COLORS.panel, borderRadius: 22, opacity: 0.75, border: `1px solid ${COLORS.panelEdge}` }} />

          <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d', transform: `perspective(1600px) rotateY(${flip}deg)` }}>
            {/* front */}
            <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', background: COLORS.panel, borderRadius: 22, border: `1px solid ${COLORS.panelEdge}`, boxShadow: '0 30px 70px rgba(0,0,0,0.4)', padding: 48, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 16, color: COLORS.gold, letterSpacing: 3 }}>Q</span>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 40, color: COLORS.ink, marginTop: 10 }}>
                What makes the DL650's engine beginner-friendly?
              </div>
            </div>
            {/* back */}
            <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)', background: '#fff', borderRadius: 22, border: `2px solid ${COLORS.green}`, boxShadow: '0 30px 70px rgba(0,0,0,0.4)', padding: 48, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 16, color: COLORS.green, letterSpacing: 3 }}>A</span>
              <div style={{ fontFamily: FONT_SANS, fontSize: 30, color: COLORS.ink, marginTop: 10, lineHeight: 1.4 }}>
                A low, torquey 645 cc V-twin — smooth power down low, so it's forgiving at slow speed.
              </div>
            </div>
          </div>
        </div>

        {/* deck progress */}
        <div style={{ marginTop: 46, width: 720, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.15)' }}>
            <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 4, background: `linear-gradient(90deg, ${COLORS.gold}, ${COLORS.green})` }} />
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 18, color: COLORS.panel }}>{showBack ? '6' : '5'} / 12</span>
        </div>
      </AbsoluteFill>
      <Caption kicker="/flashcard" title="A smart deck from your notes — tap to flip" />
    </Backdrop>
  );
};
