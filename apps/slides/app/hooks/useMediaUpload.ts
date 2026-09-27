import { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadMultipart,
  type MediaUploadOptions,
  type MultipartUploadResult,
} from '@classmoji/ui-components/upload';
import { mediaUploadMessage } from '~/utils/mediaUpload';

/** Where the slides app's own media routes hang. */
const MEDIA_ENDPOINTS = { base: '/api/media' };

export interface MediaUploadState {
  /** The file in flight, or null when nothing is. */
  file: { name: string; size: number } | null;
  sentBytes: number;
  /** The last failure, as a sentence. Null after a cancel. */
  error: string | null;
}

/**
 * One media upload at a time, with progress and a cancel.
 *
 * `start` resolves with the uploaded object, or with null when the upload was
 * cancelled or failed — the failure is in `state.error`, already worded, so a
 * caller never has to put a code in front of a person. Unmounting cancels.
 */
export function useMediaUpload(classroomId: string | null | undefined) {
  const [state, setState] = useState<MediaUploadState>({ file: null, sentBytes: 0, error: null });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(
    async (file: File, options: MediaUploadOptions = {}): Promise<MultipartUploadResult | null> => {
      if (!classroomId) {
        setState({
          file: null,
          sentBytes: 0,
          error: mediaUploadMessage({ code: 'NOT_CONFIGURED' }),
        });
        return null;
      }
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setState({ file: { name: file.name, size: file.size }, sentBytes: 0, error: null });

      try {
        const result = await uploadMultipart({
          file,
          classroomId,
          options,
          endpoints: MEDIA_ENDPOINTS,
          signal: abort.signal,
          onProgress: progress => setState(prev => ({ ...prev, sentBytes: progress.sentBytes })),
        });
        setState({ file: null, sentBytes: 0, error: null });
        return result;
      } catch (error: unknown) {
        setState({
          file: null,
          sentBytes: 0,
          error: mediaUploadMessage(error as { code?: string }),
        });
        return null;
      } finally {
        if (controller.current === abort) controller.current = null;
      }
    },
    [classroomId]
  );

  const cancel = useCallback(() => controller.current?.abort(), []);
  const clearError = useCallback(() => setState(prev => ({ ...prev, error: null })), []);

  return { state, start, cancel, clearError, uploading: state.file !== null };
}
