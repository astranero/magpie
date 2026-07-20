import React, { useEffect, useState } from 'react';

/**
 * Renders `magpie-img://{imgId}` image refs: extracted PDF figures and inlined
 * import images live as Blobs in the docImages store (never inline in the
 * markdown), resolved on demand through the service worker.
 */
export const MagpieImage: React.FC<{ src?: string; alt?: string; docId?: string; className?: string }> = ({
  src, alt, docId, className,
}) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isMagpie = typeof src === 'string' && src.startsWith('magpie-img://');

  useEffect(() => {
    if (!isMagpie || !docId) return;
    const imgId = src!.slice('magpie-img://'.length);
    let alive = true;
    try {
      chrome.runtime.sendMessage({ action: 'GET_DOC_IMAGE', docId, imgId }, (res: any) => {
        if (!alive) return;
        if (chrome.runtime.lastError) { setFailed(true); return; }
        if (res?.found && res.dataUrl) setDataUrl(res.dataUrl);
        else setFailed(true);
      });
    } catch { setFailed(true); }
    return () => { alive = false; };
  }, [src, docId, isMagpie]);

  if (!isMagpie) {
    // Plain image (data: URL or http) — render directly.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt || ''} className={className} />;
  }
  if (failed) {
    return (
      <span className="block rounded-lg border border-dashed border-border px-3 py-2 text-[10px] text-muted-foreground font-mono">
        [{alt || 'figure'} — image not found]
      </span>
    );
  }
  if (!dataUrl) {
    return (
      <span className="block rounded-lg border border-border bg-muted/30 px-3 py-6 text-center text-[10px] text-muted-foreground font-mono animate-pulse">
        {alt || 'loading figure…'}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={dataUrl} alt={alt || ''} className={className} />;
};

/** urlTransform allowlist extension for the magpie-img scheme. */
export function allowMagpieImgUrl(url: string): string {
  return url.startsWith('magpie-img://') ? url : '';
}
