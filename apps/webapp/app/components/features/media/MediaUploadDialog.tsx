import { useEffect, useReducer, useRef } from 'react';
import { Button, Modal } from 'antd';
import { IconUpload } from '@tabler/icons-react';
import type {
  MultipartUploadError,
  MultipartUploadResult,
  uploadMultipart,
} from '@classmoji/ui-components';

import { MediaVideoOptions } from '@classmoji/ui-components/media-options';
import '@classmoji/ui-components/styles/media-options.css';
import {
  createUploadOptions,
  formatBytes,
  isVideoFilename,
  precheck,
  type QuotaSummary,
} from './mediaUploadOptions';
import { INITIAL_UPLOAD_DIALOG_STATE, uploadDialogReducer } from './uploadDialogState';

/**
 * Pick a file, choose what happens to it, watch it go.
 *
 * The bytes never touch our servers: the client talks to `/api/media` for three
 * small JSON calls and sends the file itself straight to storage. That is why
 * this dialog owns an `AbortController` rather than relying on unmounting —
 * a half-finished multipart upload is a real object holding real quota, and
 * cancelling has to reach the network, not just the screen.
 *
 * The upload function arrives as a prop so the dialog can be driven with a
 * double, and so the route that mounts it decides which endpoints it hits.
 */

interface MediaUploadDialogProps {
  open: boolean;
  onClose: () => void;
  classroomId: string;
  quota: QuotaSummary;
  upload: typeof uploadMultipart;
  onUploaded: (result: MultipartUploadResult) => void;
}

/**
 * Codes come from the service; the wording is this dialog's job.
 *
 * Exported so the mapping can be asserted directly: every case here is a
 * sentence an uploader reads at the one moment their upload has failed, and a
 * code that fell through to the default would read as a network problem when it
 * is nothing of the kind.
 */
export function messageFor(error: MultipartUploadError, quota: QuotaSummary): string {
  switch (error.code) {
    case 'NOT_CONFIGURED':
      return "Uploading here isn't available right now.";
    case 'PRO_REQUIRED':
      return 'Uploading media needs a Pro classroom.';
    case 'DELIVERY_REQUIRED':
      return "This class isn't set up to serve content yet, so media can't be uploaded.";
    case 'QUOTA_EXCEEDED': {
      const used = error.usedBytes ?? quota.usedBytes;
      const total = error.quotaBytes ?? quota.quotaBytes;
      return `Not enough storage — ${formatBytes(used)} of ${formatBytes(total)} is already in use. Delete something and try again.`;
    }
    case 'FILE_TOO_LARGE':
      return `That file is over the ${formatBytes(quota.perFileBytes)} limit for a single upload.`;
    case 'KIND_NOT_ALLOWED':
      return "That file can't be uploaded. It needs an extension of at most 8 letters or digits.";
    case 'SIZE_MISMATCH':
      return 'The upload did not arrive intact and was discarded. Please try again.';
    case 'VERIFY_FAILED':
      return "The upload couldn't be verified. Try again.";
    case 'UPLOAD_EXPIRED':
      return 'This upload took too long. Start it again.';
    case 'NOT_FOUND':
    case 'BAD_STATE':
      return 'This upload is no longer valid. Please start it again.';
    default:
      return 'The upload could not finish. Check your connection and try again.';
  }
}

const MediaUploadDialog = ({
  open,
  onClose,
  classroomId,
  quota,
  upload,
  onUploaded,
}: MediaUploadDialogProps) => {
  const [state, dispatch] = useReducer(uploadDialogReducer, INITIAL_UPLOAD_DIALOG_STATE);
  const { file, options, refusal, error, sentBytes, phase, closeRequested } = state;
  const uploading = phase === 'uploading';
  const done = phase === 'done';
  // Nothing is editable once an upload is under way or finished.
  const locked = phase !== 'idle';
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // A reopened dialog starts clean; a stale progress bar from the last upload
  // would be read as this one already being under way.
  useEffect(() => {
    if (!open) dispatch({ type: 'reset' });
  }, [open]);

  // Close only once the finished — or cancelled — frame is on screen. Closing
  // in the same render as the success or the cancel would freeze the Modal on
  // the frame before it: the progress bar and a live "Cancel upload" (see
  // `uploadDialogState.ts`).
  useEffect(() => {
    if (phase === 'done' || closeRequested) onClose();
  }, [phase, closeRequested, onClose]);

  // Nothing survives an unmount: the request is cancelled rather than left to
  // finish against a component that is gone.
  useEffect(() => () => abortRef.current?.abort(), []);

  const chooseFile = (chosen: File | null) =>
    dispatch({ type: 'choose', file: chosen, refusal: chosen ? precheck(chosen, quota) : null });

  // Back to idle at once. The client stops its PUTs and sends the server-side
  // abort on its own, un-awaited; nothing here waits for that answer.
  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: 'cancelled' });
  };

  // X and Escape. Mid-upload, cancel first and let the effect above close once
  // the cancelled frame has rendered; otherwise there is no live frame to
  // leave behind, so close at once.
  const close = () => {
    if (!uploading) {
      onClose();
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: 'cancelled', close: true });
  };

  const start = async () => {
    if (!file || refusal || phase !== 'idle') return;
    const controller = new AbortController();
    abortRef.current = controller;
    // A number of its own, so this upload's callbacks can be told from a later one's.
    runRef.current += 1;
    const run = runRef.current;
    dispatch({ type: 'start', run });

    try {
      const result = await upload({
        file,
        classroomId,
        options: createUploadOptions(file.name, options),
        endpoints: { base: '/api/media' },
        onProgress: progress => dispatch({ type: 'progress', run, sentBytes: progress.sentBytes }),
        signal: controller.signal,
      });
      // The file is stored whether or not this run is still the one on screen,
      // so the list refreshes either way; only the dialog ignores a stale run.
      onUploaded(result);
      dispatch({ type: 'succeeded', run });
    } catch (thrown) {
      const failure = thrown as MultipartUploadError;
      // A cancel is not a failure and says so by staying silent.
      dispatch({
        type: 'failed',
        run,
        error: failure?.code === 'ABORTED' ? null : messageFor(failure, quota),
      });
    } finally {
      // Only our own controller: a cancel followed by a fresh Upload has
      // already put the next run's controller here.
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const total = file?.size ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((sentBytes / total) * 100)) : 0;
  const free = Math.max(0, quota.quotaBytes - quota.usedBytes);

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      width={520}
      maskClosable={!uploading}
      destroyOnHidden
    >
      <div className="pr-6">
        <h2 className="mb-1 text-lg font-semibold text-ink-0">Upload media</h2>
        <p className="mb-5 text-sm text-ink-3">
          Video, audio, documents, archives — any file with an extension. {formatBytes(free)} free
          of {formatBytes(quota.quotaBytes)}, up to {formatBytes(quota.perFileBytes)} per file.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <input
            ref={inputRef}
            type="file"
            disabled={locked}
            onChange={event => chooseFile(event.target.files?.[0] ?? null)}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={locked}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-line transition-colors hover:bg-nav-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <IconUpload size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-0">
                {file ? file.name : 'Choose a file'}
              </span>
              <span className="block text-xs text-ink-3">
                {file ? formatBytes(file.size) : 'Any file with an extension'}
              </span>
            </span>
          </button>
        </div>

        {refusal && (
          <p className="rounded-xl bg-peach-bg px-3 py-2 text-xs text-peach-ink ring-1 ring-peach-bord">
            {refusal}
          </p>
        )}

        {/* The three video choices, for a video only: a pdf or an mp3 has
            nothing to decide, and an empty options area would only invite a
            search for settings that are not there. */}
        {file && !refusal && isVideoFilename(file.name) && (
          <MediaVideoOptions
            filename={file.name}
            value={options}
            disabled={locked}
            onChange={(field, next) => dispatch({ type: 'option', field, value: next })}
          />
        )}

        {uploading && (
          <div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 w-full overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-ink-3">
              {formatBytes(sentBytes)} of {formatBytes(total)} · {percent}%
            </p>
          </div>
        )}

        {done && (
          <p role="status" className="text-sm font-semibold text-ink-0">
            Uploaded.
          </p>
        )}

        {error && (
          <p className="rounded-xl bg-peach-bg px-3 py-2 text-xs text-peach-ink ring-1 ring-peach-bord">
            {error}
          </p>
        )}

        {done ? (
          // What stays on screen while the dialog closes itself: a finished
          // upload with nothing left to cancel.
          <div className="flex justify-end gap-2">
            <Button type="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            {/* Cancelling an upload keeps the dialog, and the file, where they
                were; the X still cancels and closes in one go. */}
            <Button onClick={uploading ? cancel : close}>
              {uploading ? 'Cancel upload' : 'Cancel'}
            </Button>
            <Button
              type="primary"
              onClick={start}
              loading={uploading}
              disabled={!file || Boolean(refusal) || uploading}
            >
              Upload
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default MediaUploadDialog;
