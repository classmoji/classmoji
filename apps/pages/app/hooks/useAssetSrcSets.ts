import { createContext, useContext } from 'react';

/**
 * Responsive candidates for the images in the document being rendered.
 *
 * Keyed by the STORED reference — `pages/lab-1/assets/hero.png` — not by the
 * signed URL. That is the whole reason this works at all: a block knows its own
 * `props.url` synchronously, on its first render, while the signed URL arrives
 * later from an async `resolveFileUrl` and depends on a clock, an expiry bucket
 * and the viewer's tier. Keying by the signed URL means a block cannot look
 * itself up without reproducing a signature.
 *
 * A React context rather than an editor option because BlockNote's block
 * renders are portalled into the `BlockNoteView` tree — its own file blocks use
 * context for their dictionary and editor — so a provider above the view
 * reaches them.
 */

/** `{ storedRef: srcset }`. A missing key means "render one size". */
export type AssetSrcSets = Record<string, string>;

/** Frozen so the default can never be mutated into a shared cache. */
const NO_SRC_SETS: AssetSrcSets = Object.freeze({});

export const AssetSrcSetContext = createContext<AssetSrcSets>(NO_SRC_SETS);

/**
 * The whole map, for a block to look itself up in.
 *
 * The lookup itself lives in `responsiveImageAttrs`, shared with the class
 * site's static renders — the two surfaces key the map differently (stored
 * reference here, signed URL there) and must not also drift on what a hit
 * means.
 */
export function useAssetSrcSets(): AssetSrcSets {
  return useContext(AssetSrcSetContext);
}

export { NO_SRC_SETS };
