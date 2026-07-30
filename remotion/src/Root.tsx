import React from 'react';
import { Composition } from 'remotion';
import { MagpieDemo } from './MagpieDemo';
import { FPS, WIDTH, HEIGHT, TOTAL } from './theme';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="MagpieDemo"
    component={MagpieDemo}
    durationInFrames={TOTAL}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
