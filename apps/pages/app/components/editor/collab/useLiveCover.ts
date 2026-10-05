import { useCallback, useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { COVER_IMAGE_KEY, META_MAP } from '@classmoji/page-schema/constants';

import { readCoverValue, type CollabCoverImage } from '~/utils/collab.ts';

/**
 * The page cover, read from and written to the live document's meta map
 * (`doc.getMap(META_MAP).get(COVER_IMAGE_KEY)`), so a cover change reaches
 * every editor at once and lands in the next checkpoint with the blocks.
 *
 * Until the room has synced the local document is empty, so `fallback` (the
 * loader's cover) is shown instead of a missing one.
 */
export function useLiveCover(
  doc: Y.Doc | null,
  hasSynced: boolean,
  fallback: CollabCoverImage | null
): {
  cover: CollabCoverImage | null;
  setCover: (cover: CollabCoverImage | null) => void;
} {
  const [value, setValue] = useState<CollabCoverImage | null>(null);

  useEffect(() => {
    if (!doc) return;
    const meta = doc.getMap(META_MAP);
    const read = () => setValue(readCoverValue(meta.get(COVER_IMAGE_KEY)));
    read();
    meta.observe(read);
    return () => meta.unobserve(read);
  }, [doc]);

  const setCover = useCallback(
    (cover: CollabCoverImage | null) => {
      if (!doc) return;
      const meta = doc.getMap(META_MAP);
      doc.transact(() => {
        if (cover) meta.set(COVER_IMAGE_KEY, { url: cover.url, position: cover.position });
        else meta.delete(COVER_IMAGE_KEY);
      });
    },
    [doc]
  );

  return { cover: doc && hasSynced ? value : fallback, setCover };
}
