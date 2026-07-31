import React from 'react';
import { AbsoluteFill, Series } from 'remotion';
import { SCENES } from './theme';
import { Hero } from './scenes/Hero';
import { Capture } from './scenes/Capture';
import { Research } from './scenes/Research';
import { Chat } from './scenes/Chat';
import { Teach } from './scenes/Teach';
import { Flashcard } from './scenes/Flashcard';
import { DataAgent } from './scenes/DataAgent';
import { DriveSync } from './scenes/DriveSync';
import { Outro } from './scenes/Outro';

// A short cross-fade between scenes so cuts don't feel abrupt. Remotion's
// Series overlaps by `offset` frames; we fade the incoming scene in.
const SCENE_LIST: Array<[keyof typeof SCENES, React.FC]> = [
  ['hero', Hero],
  ['capture', Capture],
  ['research', Research],
  ['chat', Chat],
  ['teach', Teach],
  ['flashcard', Flashcard],
  ['data', DataAgent],
  ['drive', DriveSync],
  ['outro', Outro],
];

export const MagpieDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#16130F' }}>
    <Series>
      {SCENE_LIST.map(([key, Comp]) => (
        <Series.Sequence key={key} durationInFrames={SCENES[key]}>
          <Comp />
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
