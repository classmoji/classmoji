import { imageSizesFor } from '~/utils/imageSizes.ts';
import type { ReaderPayload } from '~/utils/readerPayload.ts';

/**
 * `<link rel="preload" as="image">` for the first images of a site page, so
 * the browser fetches them while the reader island loads instead of after.
 *
 * Read from the payload THIS viewer ships and nothing else: its document (a
 * non-member's has every locked body removed already) and its own display
 * URL and srcset maps. So a preload can only name an image the same response
 * would hand the reader anyway. Images inside a toggle (closed on the site)
 * are skipped; an empty document has none.
 */
export interface ImagePreload {
  href: string;
  imageSrcSet?: string;
  imageSizes?: string;
  fetchPriority?: 'high';
}

/** How many images are preloaded. */
export const IMAGE_PRELOAD_MAX = 2;

type LooseBlock = {
  type?: unknown;
  props?: { url?: unknown; previewWidth?: unknown; isToggleable?: unknown } | null;
  children?: unknown;
};

/** A URL a browser can fetch for this page: http(s), or a path on this host. */
const fetchable = (url: string) => /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url);

export function imagePreloadsFor(payload: ReaderPayload, max = IMAGE_PRELOAD_MAX): ImagePreload[] {
  const out: ImagePreload[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as LooseBlock[]) {
      if (out.length >= max) return;
      if (!block || typeof block !== 'object') continue;
      const ref = block.props?.url;
      if (block.type === 'image' && typeof ref === 'string' && ref) {
        const href = Object.hasOwn(payload.assets, ref) ? payload.assets[ref] : ref;
        if (typeof href === 'string' && fetchable(href)) {
          const srcSet = payload.srcSets[ref];
          const width = block.props?.previewWidth;
          out.push({
            href,
            ...(srcSet
              ? {
                  imageSrcSet: srcSet,
                  imageSizes: imageSizesFor(typeof width === 'number' ? width : null),
                }
              : {}),
            ...(out.length === 0 ? { fetchPriority: 'high' as const } : {}),
          });
        }
      }
      // A toggle's body is closed on the site: nothing in it is on screen.
      const toggle = block.type === 'toggleListItem' || block.props?.isToggleable === true;
      if (!toggle) walk(block.children);
    }
  };
  walk(payload.content);
  return out;
}

/** The preloads as `meta` descriptors (rendered by `<Meta/>` in the head). */
export function imagePreloadMeta(preloads: readonly ImagePreload[]) {
  return preloads.map(preload => ({
    tagName: 'link' as const,
    rel: 'preload',
    as: 'image',
    href: preload.href,
    ...(preload.imageSrcSet
      ? { imageSrcSet: preload.imageSrcSet, imageSizes: preload.imageSizes }
      : {}),
    ...(preload.fetchPriority ? { fetchPriority: preload.fetchPriority } : {}),
  }));
}
