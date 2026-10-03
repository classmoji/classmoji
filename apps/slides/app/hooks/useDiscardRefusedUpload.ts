import { useCallback, useEffect, useRef } from 'react';
import { discardUploadedMedia } from '~/utils/mediaClient';

/**
 * Throw away a document uploaded to media for a file slide the server then
 * refused.
 *
 * Call `remember(mediaId)` right before posting the form with that id. When
 * the action answers with an error and `discardMedia: true` (the server found
 * no slide pointing at the object), the object is deleted; any other answer
 * just forgets it. Success redirects, so there is nothing to do then.
 */
export function useDiscardRefusedUpload(
  actionData: { discardMedia?: boolean } | null | undefined
): (mediaId: string) => void {
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!actionData) return;
    const mediaId = pending.current;
    pending.current = null;
    if (mediaId && actionData.discardMedia === true) void discardUploadedMedia(mediaId);
  }, [actionData]);

  return useCallback((mediaId: string) => {
    pending.current = mediaId;
  }, []);
}
