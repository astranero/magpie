import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Magpie, useRise } from '../components/ui';
import { COLORS, FONT_DISPLAY, FONT_MONO } from '../theme';

const FEATURES = ['Capture', 'Deep research', 'Grounded chat', '/teach', '/flashcard', '/data', 'Drive sync'];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logo = spring({ frame, fps, config: { damping: 12 } });
  const tag = useRise(20);
  const cta = useRise(60);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${interpolate(logo, [0, 1], [0.7, 1])})`, opacity: logo }}>
          <Magpie size={130} color={COLORS.panel} eye={COLORS.bg} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 76, color: COLORS.panel, fontWeight: 700, marginTop: 10, opacity: logo }}>
          Magpie
        </div>

        {/* feature pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', maxWidth: 900, marginTop: 26 }}>
          {FEATURES.map((f, i) => {
            const s = spring({ frame: frame - (30 + i * 6), fps, config: { damping: 200 } });
            return (
              <span key={f} style={{ opacity: s, transform: `translateY(${interpolate(s, [0, 1], [16, 0])}px)`, padding: '10px 20px', borderRadius: 999, border: `1.5px solid ${COLORS.gold}`, color: COLORS.gold, fontFamily: FONT_MONO, fontSize: 20 }}>
                {f}
              </span>
            );
          })}
        </div>

        <div style={{ ...tag, fontFamily: FONT_DISPLAY, fontSize: 34, color: COLORS.greenWash, marginTop: 40 }}>
          Everything stays on your device.
        </div>
        <div style={{ ...cta, fontFamily: FONT_MONO, fontSize: 24, color: COLORS.blue, marginTop: 14, background: '#fff', padding: '10px 22px', borderRadius: 12 }}>
          github.com/astranero/magpie
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
