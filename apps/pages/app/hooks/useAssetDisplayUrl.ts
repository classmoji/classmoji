import { createContext, useContext } from 'react';

/**
 * The SYNCHRONOUS half of render-time URL resolution.
 *
 * The document stores references (`pages/lab-1/assets/loop.gif`) and the loader
 * ships a parallel `ref → signed URL` map, so by the time any block renders the
 * answer already exists — in memory, on this tick. `resolveFileUrl` is the
 * async door onto that same map, and async is BlockNote's contract, not a fact
 * about the data.
 *
 * That distinction is the bug this context exists to close. A block that only
 * had the async door painted the bare reference on its first commit and swapped
 * the signed URL in afterwards; the browser does not wait for the second commit
 * to start fetching, so every image without a `srcset` to distract it — a GIF,
 * an SVG, anything the rendition ladder does not cover — issued a doomed
 * request to `https://pages.../pages/<slug>/assets/<file>` before loading
 * correctly. Raster images hid it only because `responsiveImageAttrs` gave the
 * browser a candidate list to pick from instead of `src`.
 *
 * A React context, and deliberately the same delivery mechanism
 * `useAssetSrcSets` uses: BlockNote portals every block render into the
 * `BlockNoteView` tree, so a provider above the view is what reaches them. Both
 * values are keyed by the stored reference, which a block has synchronously on
 * its first render.
 */

/** Stored reference in, display URL out. A miss returns the reference unchanged. */
export type DisplayUrlLookup = (ref: string) => string;

/**
 * No provider — and, equally, a deployment with the delivery layer switched
 * off. In both the reference IS the URL, which is what every surface degraded
 * to before any of this existed.
 */
export const IDENTITY_DISPLAY_URL: DisplayUrlLookup = ref => ref;

export const AssetDisplayUrlContext = createContext<DisplayUrlLookup>(IDENTITY_DISPLAY_URL);

/** The lookup for the document being rendered. Safe to call during render. */
export function useAssetDisplayUrl(): DisplayUrlLookup {
  return useContext(AssetDisplayUrlContext);
}
