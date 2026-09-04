import { useEffect } from 'react';

/**
 * Responsive candidates for the images BlockNote renders.
 *
 * BlockNote owns the `<img>`. Its image block asks the editor for ONE URL
 * (`resolveFileUrl`, which returns a string) and renders it, and there is no
 * seam in that contract for a second value — so a `srcset` cannot be handed in
 * the way a `src` can. Replacing the whole image block spec to add two
 * attributes would mean owning its resize handles, its caption, its upload
 * placeholder and its toolbars forever, which is a large amount of surface to
 * take on for `srcset` and `sizes`.
 *
 * So this decorates instead. The loader ships a `resolved src → srcset` map —
 * keyed by the exact URL the block will render, because `resolveSrcSets`
 * returns the untransformed original as its `src` and that is the same string
 * `resolveMany` put in the display map — and a `MutationObserver` applies it to
 * every `<img>` that appears inside the content container.
 *
 * An observer rather than a one-shot effect because images appear late and
 * repeatedly: BlockNote paints asynchronously, a paste inserts one, an upload
 * swaps one in. React never sets `srcset` itself, so there is nothing to fight
 * over — a re-render that replaces the element brings a fresh `<img>` through
 * the observer again.
 */

/** Apply the map to every image under `root` that has not been decorated. */
export function applyImageSrcSets(
  root: ParentNode,
  srcsets: Record<string, string>,
  sizes: string
): void {
  for (const img of root.querySelectorAll('img')) {
    // An existing `srcset` is either ours from a previous pass or an author's.
    // Either way it is not this pass's to overwrite.
    if (img.hasAttribute('srcset')) continue;
    const srcset = srcsets[img.getAttribute('src') ?? ''];
    if (!srcset) continue;
    img.setAttribute('srcset', srcset);
    img.setAttribute('sizes', sizes);
  }
}

export function useImageSrcSets(
  ref: { current: HTMLElement | null },
  srcsets: Record<string, string> | null | undefined,
  sizes: string,
  /**
   * Bumped when the document identity changes (the page id, an asset-retry
   * epoch), so a remount re-decorates rather than inheriting the last page's
   * observer.
   */
  resetKey?: string
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root || !srcsets || Object.keys(srcsets).length === 0) return;

    applyImageSrcSets(root, srcsets, sizes);

    const observer = new MutationObserver(records => {
      // Attribute mutations are ignored: this pass SETS attributes, and reacting
      // to its own writes is how an observer turns into a loop. Only new nodes
      // can bring an image that has not been decorated.
      if (!records.some(record => record.addedNodes.length > 0)) return;
      applyImageSrcSets(root, srcsets, sizes);
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => observer.disconnect();
    // `ref` is in here for the linter's benefit; a ref OBJECT is stable across
    // renders, so it never actually re-subscribes.
  }, [ref, srcsets, sizes, resetKey]);
}
