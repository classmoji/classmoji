import { useCallback, useEffect, useRef, useState } from 'react';
import type { useFetcher } from 'react-router';
import { toast } from 'react-toastify';
import { kindOfFilename, type UploadCapability } from '@classmoji/services/media/router';

import { sendToMedia } from './mediaUpload.ts';
import { usePageMedia } from './PageMedia.tsx';
import {
  UploadCancelled,
  UploadRefused,
  UploadReroute,
  actionFailureMessage,
  firstDestination,
  type ActionFailure,
} from './uploadRouting.ts';

type CoverFetcher = ReturnType<typeof useFetcher>;

/** A cover is rendered as an image; media serves only these as one. */
const COVER_NOT_AN_IMAGE = 'A cover must be an image (PNG, JPG, GIF or WebP).';

/** The two stores kept handing the cover back to each other. */
const COVER_NOWHERE = 'This image could not be stored. Reload the page and try again.';

const GENERIC_FAILURE = 'The upload could not finish. Check your connection and try again.';

/**
 * Upload a page cover through the storage router, and report its failures.
 *
 * A cover goes where any other file of its size would (`storageTargetFor`):
 * the course repository through the page action's `upload-header-image`, or —
 * over the repository's cap on a classroom with media — straight to media, then
 * `set-header-image` with the `media://` reference. The capability can be
 * stale, so the server's answer wins once, exactly as in the editor: a
 * repository upload answered `USE_MEDIA` goes to media, a media upload the
 * server keeps in the repository goes there. A second disagreement is refused.
 *
 * Owns the fetcher's failure toast too, so a code never reaches the screen:
 * pass the fetcher every cover mutation on this surface goes through.
 */
export function useCoverUpload(
  fetcher: CoverFetcher,
  capability: UploadCapability | null | undefined
) {
  const media = usePageMedia();
  // The file behind a repository submission in flight, kept for the one
  // redirect to media its answer may ask for.
  const repoFileRef = useRef<File | null>(null);
  const [sendingToMedia, setSendingToMedia] = useState(false);
  const capabilityRef = useRef(capability);
  capabilityRef.current = capability;

  const submitToRepo = useCallback(
    (file: File) => {
      repoFileRef.current = file;
      const formData = new FormData();
      formData.append('intent', 'upload-header-image');
      formData.append('file', file);
      fetcher.submit(formData, { method: 'POST', encType: 'multipart/form-data' });
    },
    [fetcher]
  );

  const submitToMedia = useCallback(
    async (file: File, redirected: boolean) => {
      if (kindOfFilename(file.name) !== 'IMAGE') {
        toast.error(COVER_NOT_AN_IMAGE);
        return;
      }
      setSendingToMedia(true);
      try {
        const { ref } = await sendToMedia({
          file,
          classroomId: media.classroomId,
          options: undefined,
          capability: capabilityRef.current,
        });
        // The display URL first, so the cover paints the moment it is set.
        await media.place(ref);
        fetcher.submit(
          { intent: 'set-header-image', url: ref, position: 50 },
          { method: 'POST', encType: 'application/json' }
        );
      } catch (error) {
        if (error instanceof UploadCancelled) return;
        if (error instanceof UploadReroute && error.to === 'repo') {
          if (redirected) toast.error(COVER_NOWHERE);
          else submitToRepo(file);
          return;
        }
        toast.error(error instanceof UploadRefused ? error.message : GENERIC_FAILURE);
      } finally {
        setSendingToMedia(false);
      }
    },
    [fetcher, media, submitToRepo]
  );

  const upload = useCallback(
    (file: File) => {
      const first = firstDestination(capabilityRef.current, file);
      if (first.kind === 'refused') {
        toast.error(first.message);
        return;
      }
      if (first.kind === 'media') void submitToMedia(file, false);
      else submitToRepo(file);
    },
    [submitToMedia, submitToRepo]
  );

  // The answer already on the fetcher when this mounted belongs to an earlier
  // mount — `coverFetcher` outlives "Add cover" across page navigations — and
  // was shown then; it is not shown again.
  const dataAtMountRef = useRef(fetcher.data);

  // The action's answer: one redirect to media, or the sentence to show.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data === dataAtMountRef.current) return;
    const data = fetcher.data as ActionFailure | undefined;
    const file = repoFileRef.current;
    repoFileRef.current = null;
    if (data?.error === 'USE_MEDIA' && file) {
      void submitToMedia(file, true);
      return;
    }
    const message = actionFailureMessage(data);
    if (message) toast.error(message);
    // Only a fresh answer: `submitToMedia` changing identity is not one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const uploadingToRepo =
    fetcher.state !== 'idle' && fetcher.formData?.get('intent') === 'upload-header-image';

  return { upload, uploading: sendingToMedia || uploadingToRepo };
}
