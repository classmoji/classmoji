import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from 'antd';
import { IconUpload } from '@tabler/icons-react';
import type {
  MultipartUploadError,
  MultipartUploadResult,
  uploadMultipart,
} from '@classmoji/ui-components';

import MediaVideoOptions from './MediaVideoOptions';
import {
  DEFAULT_VIDEO_OPTIONS,
  MEDIA_ACCEPT,
  applyVideoOption,
  formatBytes,
  isVideoFilename,
  precheck,
  type QuotaSummary,
  type VideoOptions,
} from './mediaUploadOptions';

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

/** Codes come from the service; the wording is this dialog's job. */
function messageFor(error: MultipartUploadError, quota: QuotaSummary): string {
  switch (error.code) {
    case 'NOT_CONFIGURED':
      return 'Media storage is not configured in this environment.';
    case 'PRO_REQUIRED':
      return 'Uploading media needs a Pro classroom.';
    case 'QUOTA_EXCEEDED': {
      const used = error.usedBytes ?? quota.usedBytes;
      const total = error.quotaBytes ?? quota.quotaBytes;
      return `Not enough storage — ${formatBytes(used)} of ${formatBytes(total)} is already in use. Delete something and try again.`;
    }
    case 'FILE_TOO_LARGE':
      return `That file is over the ${formatBytes(quota.perFileBytes)} limit for a single upload.`;
    case 'KIND_NOT_ALLOWED':
      return "That file type can't be uploaded.";
    case 'SIZE_MISMATCH':
      return 'The upload did not arrive intact and was discarded. Please try again.';
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
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<VideoOptions>(DEFAULT_VIDEO_OPTIONS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentBytes, setSentBytes] = useState(0);
  const [uploading, setUploading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A reopened dialog starts clean; a stale progress bar from the last upload
  // would be read as this one already being under way.
  useEffect(() => {
    if (open) return;
    setFile(null);
    setOptions(DEFAULT_VIDEO_OPTIONS);
    setRefusal(null);
    setError(null);
    setSentBytes(0);
  }, [open]);

  // Nothing survives an unmount: the request is cancelled rather than left to
  // finish against a component that is gone.
  useEffect(() => () => abortRef.current?.abort(), []);

  const chooseFile = (chosen: File | null) => {
    setError(null);
    setSentBytes(0);
    setFile(chosen);
    setRefusal(chosen ? precheck(chosen, quota) : null);
    setOptions(DEFAULT_VIDEO_OPTIONS);
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setUploading(false);
    setSentBytes(0);
  };

  const close = () => {
    if (uploading) cancel();
    onClose();
  };

  const start = async () => {
    if (!file || refusal) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    setError(null);
    setSentBytes(0);

    try {
      const result = await upload({
        file,
        classroomId,
        options: isVideoFilename(file.name) ? options : undefined,
        endpoints: { base: '/api/media' },
        onProgress: progress => setSentBytes(progress.sentBytes),
        signal: controller.signal,
      });
      setUploading(false);
      abortRef.current = null;
      onUploaded(result);
      onClose();
    } catch (thrown) {
      const failure = thrown as MultipartUploadError;
      setUploading(false);
      abortRef.current = null;
      // A cancel is not a failure and says so by staying silent.
      if (failure?.code !== 'ABORTED') setError(messageFor(failure, quota));
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
          Video, audio, documents and archives. {formatBytes(free)} free of{' '}
          {formatBytes(quota.quotaBytes)}, up to {formatBytes(quota.perFileBytes)} per file.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <input
            ref={inputRef}
            type="file"
            accept={MEDIA_ACCEPT}
            disabled={uploading}
            onChange={event => chooseFile(event.target.files?.[0] ?? null)}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-line transition-colors hover:bg-nav-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <IconUpload size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-0">
                {file ? file.name : 'Choose a file'}
              </span>
              <span className="block text-xs text-ink-3">
                {file ? formatBytes(file.size) : 'mp4, mov, webm, mp3, pdf, pptx, key, zip…'}
              </span>
            </span>
          </button>
        </div>

        {refusal && (
          <p className="rounded-xl bg-peach-bg px-3 py-2 text-xs text-peach-ink ring-1 ring-peach-bord">
            {refusal}
          </p>
        )}

        {file && !refusal && (
          <MediaVideoOptions
            filename={file.name}
            value={options}
            disabled={uploading}
            onChange={(field, next) =>
              setOptions(current => applyVideoOption(current, field, next))
            }
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

        {error && (
          <p className="rounded-xl bg-peach-bg px-3 py-2 text-xs text-peach-ink ring-1 ring-peach-bord">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={close}>{uploading ? 'Cancel upload' : 'Cancel'}</Button>
          <Button
            type="primary"
            onClick={start}
            loading={uploading}
            disabled={!file || Boolean(refusal) || uploading}
          >
            Upload
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default MediaUploadDialog;
