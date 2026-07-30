import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop, Caption, Magpie, Cite, Bubble, Pill, Typewriter } from '../components/ui';
import { COLORS, FONT_MONO, FONT_SANS, FONT_DISPLAY } from '../theme';

// The real deep-research view: a dark "Field log" card that steps through the
// phases (Planning → Gathering sources → Analyzing → Reviewing), tallies
// captured sources, shows a reading bar and the latest activity line — then the
// cited report appears as a normal assistant message.
const PHASES = ['Planning', 'Gathering sources', 'Analyzing', 'Reviewing'];
const ACTIVITY = [
  'Planning sub-questions…',
  'Reading nettimoto, advrider, owner forums…',
  'Cross-checking reliability claims…',
  'Writing the report…',
];

export const Research: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const activeIdx = Math.max(0, Math.min(3, Math.floor((frame - 20) / 34)));
  const captured = Math.min(12, Math.max(0, Math.floor((frame - 40) / 6)));
  const readDone = Math.min(9, Math.max(0, Math.floor((frame - 44) / 7)));
  const reportIn = spring({ frame: frame - 175, fps, config: { damping: 200 } });
  const userIn = spring({ frame: frame - 6, fps, config: { damping: 200 } });

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 780, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* user query as a real message card */}
          <div style={{ opacity: userIn, transform: `translateY(${interpolate(userIn, [0, 1], [10, 0])}px)`, display: 'flex' }}>
            <Bubble who="user"><Pill tone="blue">/deepresearch</Pill> <span style={{ fontFamily: FONT_SANS }}>is the DL650 a good first adventure bike?</span></Bubble>
          </div>

          {/* Field log — dark ink-panel */}
          <div style={{ width: '100%', borderRadius: 14, background: '#141A28', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 24px 60px rgba(0,0,0,0.45)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ transform: `rotate(${Math.sin(frame / 5) * 8}deg)` }}><Magpie size={20} color="#EAF0F7" eye="#141A28" /></div>
              <span style={{ fontSize: 15, color: 'rgba(255,255,255,0.8)', flex: 1, fontFamily: FONT_SANS }}>Field log — chat stays open</span>
              <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, padding: '2px 8px' }}>Stop</span>
            </div>

            <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* phase rail */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {PHASES.map((p, i) => (
                  <React.Fragment key={p}>
                    {i > 0 && <span style={{ height: 1, flex: 1, background: i <= activeIdx ? `${COLORS.primary}99` : 'rgba(255,255,255,0.15)' }} />}
                    <span style={{ fontSize: 13, fontWeight: 500, padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap', background: i === activeIdx ? `${COLORS.primary}33` : 'transparent', color: i === activeIdx ? '#8FD0F0' : i < activeIdx ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)' }}>{p}</span>
                  </React.Fragment>
                ))}
              </div>

              {/* source tally */}
              {captured > 0 && (
                <div style={{ display: 'flex', gap: 16, fontFamily: FONT_MONO, fontSize: 14 }}>
                  <span style={{ color: '#6EE7B7' }}>✓ {captured} captured</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>✕ 2 skipped</span>
                </div>
              )}

              {/* reading bar */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT_MONO, fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 5 }}>
                  <span>Reading sources</span><span>{readDone}/9</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(readDone / 9) * 100}%`, background: COLORS.primary, transition: 'width 0.5s' }} />
                </div>
              </div>

              {/* latest activity */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ color: `${COLORS.primary}cc`, fontSize: 13, marginTop: 1 }}>◈</span>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)', fontFamily: FONT_SANS }}>{ACTIVITY[activeIdx]}</span>
              </div>
            </div>
          </div>

          {/* the cited report as a normal assistant message */}
          {frame > 175 && (
            <div style={{ opacity: reportIn, transform: `translateY(${interpolate(reportIn, [0, 1], [16, 0])}px)` }}>
              <Bubble who="ai">
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 600, color: COLORS.ink, marginBottom: 8 }}>The DL650 as a first adventure bike</div>
                <div style={{ fontFamily: FONT_SANS, fontSize: 18, color: COLORS.inkSoft, lineHeight: 1.6 }}>
                  <Typewriter text="Owners rate it forgiving and reliable" start={182} cps={38} />
                  {frame > 210 && <Cite n={1} />}
                  {frame > 214 && <Typewriter text=", with a low seat and torquey twin that suit new riders" start={214} cps={38} />}
                  {frame > 250 && <Cite n={2} />}
                  {frame > 254 && <span>. Upkeep is cheap </span>}
                  {frame > 258 && <Cite n={3} />}
                  {frame > 260 && <span>.</span>}
                </div>
              </Bubble>
            </div>
          )}
        </div>
      </AbsoluteFill>
      <Caption kicker="/deepresearch" title="Watch the field log — then get a cited report" />
    </Backdrop>
  );
};
