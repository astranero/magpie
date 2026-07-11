// ─────────────────────────────────────────────
// Local .md import helpers (File System Access API)
// ─────────────────────────────────────────────
import { resolveRelativePath } from './format';

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB per image

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Recursively collect all files in a directory handle, keyed by relative path. */
export async function collectDirectoryFiles(
  dirHandle: any,
  prefix = '',
  out: Map<string, any> = new Map()
): Promise<Map<string, any>> {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      out.set(path, handle);
    } else if (handle.kind === 'directory') {
      await collectDirectoryFiles(handle, path, out);
    }
  }
  return out;
}

/**
 * Inline relative image references (`![alt](rel/path.png)`) in markdown as
 * data: URLs, resolving them against sibling files from the picked folder.
 */
export async function inlineRelativeImages(
  content: string,
  mdPath: string,
  filesByPath: Map<string, any>
): Promise<string> {
  const mdDir = mdPath.includes('/') ? mdPath.slice(0, mdPath.lastIndexOf('/')) : '';

  const refs = [...content.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map(m => m[1])
    .filter(src => !/^(https?:|data:)/i.test(src) && IMAGE_EXTENSIONS.test(src));

  let result = content;
  for (const src of new Set(refs)) {
    const key = resolveRelativePath(mdDir, src);
    const handle = filesByPath.get(key);
    if (!handle) continue;
    try {
      const file: File = await handle.getFile();
      if (file.size > MAX_INLINE_IMAGE_BYTES) continue;
      const dataUrl = await fileToDataUrl(file);
      result = result.split(`(${src})`).join(`(${dataUrl})`);
    } catch {
      // Skip unreadable images
    }
  }
  return result;
}
