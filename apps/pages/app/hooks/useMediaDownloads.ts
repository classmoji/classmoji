import { createContext, useContext } from 'react';

import { mediaDownloadHref, type MediaDownloads } from '~/utils/mediaDownloads.ts';

/**
 * Stored reference in, the download button's target out — or null for no
 * button. The page loader decides which refs get one (`mediaDownloads`); this
 * only turns that decision into a link.
 *
 * A React context for the same reason `AssetDisplayUrlContext` is one:
 * BlockNote portals every block render into the `BlockNoteView` tree, so a
 * provider above the view is what reaches the video, file and audio blocks.
 * No provider (the editor) means no buttons.
 */
export type MediaDownloadLookup = (ref: string) => string | null;

export const NO_MEDIA_DOWNLOADS: MediaDownloadLookup = () => null;

export const MediaDownloadContext = createContext<MediaDownloadLookup>(NO_MEDIA_DOWNLOADS);

export function useMediaDownloadHref(ref: unknown): string | null {
  const lookup = useContext(MediaDownloadContext);
  return typeof ref === 'string' && ref ? lookup(ref) : null;
}

/** The lookup for one page: a button only for a ref the loader said yes to. */
export function mediaDownloadLookup(
  pageId: string,
  downloads: MediaDownloads | null | undefined
): MediaDownloadLookup {
  if (!downloads) return NO_MEDIA_DOWNLOADS;
  return ref => (downloads[ref] === true ? mediaDownloadHref(pageId, ref) : null);
}
