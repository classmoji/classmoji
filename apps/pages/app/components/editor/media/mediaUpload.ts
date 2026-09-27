import { toast, type Id as ToastId } from 'react-toastify';
import type { UploadCapability } from '@classmoji/services/media/router';
import {
  MultipartUploadError,
  uploadMultipart,
  type MediaUploadOptions,
} from '@classmoji/ui-components/upload';

import {
  UploadCancelled,
  UploadRefused,
  UploadReroute,
  mediaProgressLabel,
  mediaRefusalGoesToRepo,
  mediaUploadMessage,
} from './uploadRouting.ts';

/**
 * One file to the classroom's media, with a progress toast — the media half
 * of every upload the pages app makes (a block's file, a cover).
 *
 * BlockNote's own "loading" state says nothing about how far a two-gigabyte
 * upload has got, and a cover has no progress indicator at all, so the toast
 * is this module's: where the file is going, the room there was, and a bar.
 *
 * Failures come back as the routing errors `placeUpload` understands:
 * `UploadReroute('repo')` when the server keeps the file in the repository —
 * or refuses media in a way that means the capability was stale and the
 * repository can take the file (`mediaRefusalGoesToRepo`),
 * `UploadCancelled` for an abort (said nothing about), and `UploadRefused`
 * with the sentence to show for everything the server refused. Anything else
 * (a thrown `TypeError` from the network) is passed through untouched.
 */
export async function sendToMedia({
  file,
  classroomId,
  options,
  capability,
}: {
  file: File;
  classroomId: string | null | undefined;
  options: MediaUploadOptions | undefined;
  capability: UploadCapability | null | undefined;
}): Promise<{ ref: string }> {
  if (!classroomId) throw new UploadRefused("Uploading here isn't available right now.");

  const progressToast: ToastId = toast(mediaProgressLabel(file, capability), {
    progress: 0,
    autoClose: false,
    closeButton: false,
    closeOnClick: false,
    draggable: false,
  });
  try {
    const { ref } = await uploadMultipart({
      file,
      classroomId,
      options,
      endpoints: { base: '/api/media' },
      onProgress: ({ sentBytes, totalBytes }) => {
        // Held under 1: `done` is what completes the bar and closes it.
        const progress = totalBytes > 0 ? Math.min(0.99, sentBytes / totalBytes) : 0;
        toast.update(progressToast, { progress });
      },
    });
    toast.done(progressToast);
    return { ref };
  } catch (error) {
    toast.dismiss(progressToast);
    if (error instanceof MultipartUploadError) {
      // The router keeps this one in the repository after all.
      if (error.code === 'USE_REPO') throw new UploadReroute('repo');
      if (error.code === 'ABORTED') throw new UploadCancelled();
      // The capability was stale (no longer Pro, no longer delivering, media
      // down): a file the repository can take goes there instead.
      if (mediaRefusalGoesToRepo(error.code, file, capability)) throw new UploadReroute('repo');
      throw new UploadRefused(mediaUploadMessage(error, capability));
    }
    throw error;
  }
}
