import { useEffect, useState } from 'react';

/**
 * Turn a stored asset reference into the URL a custom block should render.
 *
 * BlockNote calls `resolveFileUrl` for its OWN file blocks (image, video,
 * audio, file) and nothing else. A custom block that renders a reference
 * straight into `src` therefore bypasses render-time resolution entirely and
 * asks the browser to fetch `pages/lab-1/assets/tim.jpg` relative to the pages
 * origin — a 404. This hook is that missing call.
 *
 * ## Why it starts on the reference and then swaps
 *
 * `resolveFileUrl` is async (it is allowed to be — the editor's contract says
 * so), so there is no resolved value on the first paint. Rendering the raw
 * reference for that one frame is the right default: when the delivery layer
 * is switched off the reference IS the URL (uploads store an absolute one), and
 * when it is on the swap lands in the same tick.
 *
 * The effect re-runs when `url` changes, which is what makes a just-uploaded
 * avatar appear: the upload handler seeds the display map before it writes the
 * new reference into the block, so the very next resolve is a hit.
 */
export function useResolvedFileUrl(
  url: string,
  resolveFileUrl: ((url: string) => Promise<string>) | undefined
): string {
  const [resolved, setResolved] = useState(url);

  useEffect(() => {
    // The reference is always the correct fallback, and re-seeding it here is
    // what keeps a stale resolution from one url showing under the next.
    setResolved(url);
    if (!url || !resolveFileUrl) return;

    let live = true;
    resolveFileUrl(url)
      .then(next => {
        if (live && typeof next === 'string' && next) setResolved(next);
      })
      .catch(() => {
        // A resolver that throws leaves the reference in place — the same
        // degradation every other surface takes.
      });

    return () => {
      live = false;
    };
  }, [url, resolveFileUrl]);

  return resolved;
}
