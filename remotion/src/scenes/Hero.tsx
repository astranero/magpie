import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Magpie } from '../components/ui';
import { COLORS, FONT_DISPLAY, FONT_MONO } from '../theme';

export const Hero: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, mass: 0.8 } });
  const titleIn = spring({ frame: frame - 14, fps, config: { damping: 200 } });
  const subIn = spring({ frame: frame - 26, fps, config: { damping: 200 } });
  const float = Math.sin(frame / 22) * 8;

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ transform: `translateY(${float - interpolate(pop, [0, 1], [40, 0])}px) scale(${interpolate(pop, [0, 1], [0.6, 1])})`, opacity: pop }}>
          <Magpie size={190} color={COLORS.panel} eye={COLORS.bg} />
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 108,
            fontWeight: 700,
            color: COLORS.panel,
            marginTop: 18,
            opacity: titleIn,
            transform: `translateY(${interpolate(titleIn, [0, 1], [30, 0])}px)`,
            letterSpacing: -1,
          }}
        >
          Magpie
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 27,
            color: COLORS.gold,
            marginTop: 6,
            letterSpacing: 2,
            opacity: subIn,
          }}
        >
          your local-first research assistant
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
