import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Backdrop, Caption, SidePanel, Bubble, Cite, Typewriter, useRise } from '../components/ui';
import { COLORS, FONT_SANS } from '../theme';

export const Chat: React.FC = () => {
  const frame = useCurrentFrame();
  const q = useRise(10);
  const a = useRise(70);

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <SidePanel width={720} title="Magpie · Chat">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 380 }}>
            <div style={{ ...q, display: 'flex', flexDirection: 'column' }}>
              <Bubble who="user">Which is cheaper to run over 3 years — DL650 or a Versys 650?</Bubble>
            </div>
            <div style={{ ...a, display: 'flex', flexDirection: 'column' }}>
              <Bubble who="ai">
                <span style={{ fontFamily: FONT_SANS }}>
                  <Typewriter
                    text="Both are cheap twins, but the DL650 edges it: longer service intervals and lower tyre wear "
                    start={78}
                    cps={34}
                  />
                  {frame > 150 && <Cite n={1} />}
                  {frame > 156 && (
                    <>
                      <Typewriter text=". Versys owners report pricier suspension work " start={158} cps={34} />
                      {frame > 210 && <Cite n={2} />}
                      {frame > 214 && <span>.</span>}
                    </>
                  )}
                </span>
              </Bubble>
            </div>
          </div>

          {/* grounded footer */}
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 10, paddingTop: 16, borderTop: `1px solid ${COLORS.line}` }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: COLORS.good }} />
            <span style={{ fontSize: 17, color: COLORS.muted }}>Answered from 2 sources in your library — every claim cites a real chunk.</span>
          </div>
        </SidePanel>
      </AbsoluteFill>
      <Caption kicker="Grounded chat" title="Ask across your library — answers cite their sources" />
    </Backdrop>
  );
};
