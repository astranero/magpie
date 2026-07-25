import { useEffect, useState } from 'react';
import { activeScene, SceneTheme, THEME_CHANGED_EVENT } from '@/lib/theme';

/**
 * Which scene palette is live, updating when the user switches theme.
 *
 * Listens for the same event main.tsx uses to re-apply the class, so the
 * decoration appears and disappears with the palette instead of waiting for a
 * panel reopen. Also follows the OS light/dark change, since `system` can
 * resolve into and out of a scene.
 */
export function useScene(): SceneTheme | null {
  const [scene, setScene] = useState<SceneTheme | null>(() => activeScene());
  useEffect(() => {
    // The class is toggled by main.tsx's own listener on the same event. Order
    // between the two is not guaranteed, so read on the next frame.
    const read = () => requestAnimationFrame(() => setScene(activeScene()));
    let mq: MediaQueryList | null = null;
    try {
      window.addEventListener(THEME_CHANGED_EVENT, read);
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', read);
    } catch { /* older Chrome — no live switching */ }
    return () => {
      try {
        window.removeEventListener(THEME_CHANGED_EVENT, read);
        mq?.removeEventListener('change', read);
      } catch { /* ignore */ }
    };
  }, []);
  return scene;
}
