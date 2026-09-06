import { useEffect, useState } from 'react';

import { useAssetDisplayUrl } from '~/hooks/useAssetDisplayUrl.ts';

/**
 * Turn a stored asset reference into the URL a custom block should render.
 *
 * BlockNote calls `resolveFileUrl` for its OWN file blocks (image, video,
 * audio, file) and nothing else. A custom block that renders a reference
 * straight into `src` therefore bypasses render-time resolution entirely and
 * asks the browser to fetch `pages/lab-1/assets/tim.jpg` relative to the pages
 * origin — a 404. This hook is that missing call.
 *
 * ## Why it does not start on the reference
 *
 * It used to, and that was a bug with a network request attached. The signed
 * URL was only applied in an effect, so the FIRST commit put the bare stored
 * path in `src` — and the browser starts fetching the moment an `<img>` lands,
 * without waiting to see whether React is about to swap the attribute. Every
 * image the rendition ladder does not cover (a GIF, an SVG, anything with no
 * `srcset` to give the browser a candidate to prefer over `src`) fired one
 * guaranteed 404 at the pages origin before loading correctly. Raster images
 * were not immune, only quiet: their `srcset` is computed synchronously, so the
 * browser picked a candidate and never asked for `src`.
 *
 * So resolution is now synchronous wherever it can be. The loader ships the
 * whole `ref → signed URL` map with the document and `useAssetMap` seeds it
 * during render, which means the answer already exists on the first render —
 * `resolveFileUrl` is async because BlockNote's contract says it may be, not
 * because the data is late. `useAssetDisplayUrl` reads that same map through
 * context, and the async path stays as the fallback for the refs the map does
 * not have: an upload resolved by a handler, a surface with no provider above
 * it, a future resolver that really does go to the network.
 *
 * A miss returns the reference unchanged, which is the right answer for an
 * external image, a `data:` URI, and for a deployment where the delivery layer
 * is switched off — there, the reference IS the URL.
 */
export function useResolvedFileUrl(
  url: string,
  resolveFileUrl: ((url: string) => Promise<string>) | undefined
): string {
  const displayUrl = useAssetDisplayUrl();
  // Synchronous, on this tick, before anything is committed to the DOM.
  const immediate = displayUrl(url);

  const [state, setState] = useState({ ref: url, value: immediate });

  // Adjusted DURING render rather than in an effect — React's own pattern for
  // derived state that has to follow a prop. An effect here would commit the
  // previous reference's value for one frame, and that frame is precisely what
  // sent the browser after the bare path. A just-uploaded avatar takes this
  // path too: the upload handler seeds the display map before it writes the new
  // reference into the block, so the render that sees the new `url` already has
  // its signed URL.
  let resolved = state.value;
  if (state.ref !== url) {
    resolved = immediate;
    setState({ ref: url, value: immediate });
  }

  useEffect(() => {
    if (!url || !resolveFileUrl) return;

    let live = true;
    resolveFileUrl(url)
      .then(next => {
        if (!live || typeof next !== 'string' || !next) return;
        // Guarded on the reference, so a resolution that lands after the block
        // has moved on cannot show one url's asset under the next. When the
        // synchronous lookup already found this exact URL — the common case —
        // the identical state bails out and the DOM is never touched.
        setState(prev =>
          prev.ref === url && prev.value !== next ? { ref: url, value: next } : prev
        );
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
