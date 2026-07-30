import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Caption, SidePanel, Pill, useRise } from '../components/ui';
import { COLORS, FONT_DISPLAY, FONT_SANS } from '../theme';

const STEPS = ['Why the DL650 fits beginners', 'Ergonomics & seat height', 'Running costs', 'Common faults to check'];
const OPTIONS = ['Around 2 000 km', 'Around 6 000 km', 'Every 12 000 km'];
const CORRECT = 1;

export const Teach: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = useRise(8);
  // reveal correct answer around frame 150
  const pick = spring({ frame: frame - 150, fps, config: { damping: 14 } });

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <SidePanel width={760} title="Magpie · /teach">
          <div style={{ ...head, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <Pill tone="green">Lesson 3 / 4</Pill>
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 28, color: COLORS.ink }}>Running costs</span>
          </div>

          {/* syllabus progress */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {STEPS.map((s, i) => (
              <div key={s} style={{ flex: 1, height: 8, borderRadius: 4, background: i <= 2 ? COLORS.green : COLORS.panelEdge, opacity: i === 2 ? 1 : 0.7 }} />
            ))}
          </div>

          <div style={{ fontFamily: FONT_SANS, fontSize: 20, color: COLORS.inkSoft, lineHeight: 1.6, marginBottom: 22 }}>
            The DL650's valve checks are far apart, which keeps servicing cheap. Built from <b>your</b> research,
            not the model's guesswork.
          </div>

          {/* quiz */}
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${COLORS.line}`, padding: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: COLORS.ink, marginBottom: 14 }}>Quiz · valve-check interval?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {OPTIONS.map((o, i) => {
                const correct = i === CORRECT;
                const revealed = correct ? pick : 0;
                return (
                  <div
                    key={o}
                    style={{
                      padding: '13px 16px',
                      borderRadius: 10,
                      fontSize: 19,
                      border: `2px solid ${correct ? interpolateColor(revealed) : COLORS.panelEdge}`,
                      background: correct ? `rgba(63,143,91,${0.12 * revealed})` : '#fff',
                      color: COLORS.ink,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      transform: `scale(${1 + 0.02 * revealed})`,
                    }}
                  >
                    <span style={{ width: 26, height: 26, borderRadius: 13, border: `2px solid ${correct && revealed > 0.3 ? COLORS.good : COLORS.muted}`, display: 'grid', placeItems: 'center', color: COLORS.good, fontSize: 16 }}>
                      {correct && revealed > 0.3 ? '✓' : ''}
                    </span>
                    {o}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ marginTop: 16, opacity: interpolate(pick, [0.6, 1], [0, 1], { extrapolateLeft: 'clamp' }) }}>
            <span style={{ padding: '10px 18px', borderRadius: 10, background: COLORS.green, color: '#fff', fontWeight: 700, fontSize: 18 }}>
              Continue → next lesson
            </span>
          </div>
        </SidePanel>
      </AbsoluteFill>
      <Caption kicker="/teach" title="Turn your research into a course — with quizzes" />
    </Backdrop>
  );
};

const interpolateColor = (t: number) => (t > 0.3 ? COLORS.good : COLORS.panelEdge);
