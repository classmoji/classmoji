import { useEffect, useRef, useState } from 'react';
import {
  GALLERY_IMAGE_MAX_BYTES,
  GALLERY_VIDEO_MAX_BYTES,
} from '@classmoji/services/form-contract';
import { uploadMultipart, MultipartUploadError } from '@classmoji/ui-components/upload';

export interface GalleryUploadContext {
  classroomId: string;
  basePath: string;
}

export default function GalleryMediaUpload({
  name,
  label,
  role,
  value,
  onChange,
  context,
  onBusy,
}: {
  name: string;
  label: string;
  role: 'cover' | 'video';
  value: string;
  onChange: (ref: string) => void;
  context: GalleryUploadContext;
  onBusy: (busy: boolean) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const upload = async (file: File) => {
    const limit = role === 'cover' ? GALLERY_IMAGE_MAX_BYTES : GALLERY_VIDEO_MAX_BYTES;
    if (file.size > limit) {
      setError(`The limit is ${limit / 1_000_000} MB.`);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setError('');
    setProgress(0);
    onBusy(true);
    try {
      const result = await uploadMultipart({
        file,
        classroomId: context.classroomId,
        endpoints: {
          base: `${context.basePath}/${encodeURIComponent(name.slice('answers.'.length))}`,
        },
        signal: controller.signal,
        onProgress: ({ sentBytes, totalBytes }) =>
          setProgress(Math.round((sentBytes / totalBytes) * 100)),
      });
      onChange(result.ref);
    } catch (error) {
      if (!(error instanceof MultipartUploadError && error.code === 'ABORTED')) {
        setError(
          error instanceof MultipartUploadError
            ? (error.serverMessage ?? error.message)
            : 'Upload failed. Please try again.'
        );
      }
    } finally {
      pending.current = null;
      setProgress(null);
      onBusy(false);
    }
  };
  const hosted = value.startsWith('media://');
  return (
    <div className="space-y-2">
      <input
        id={name}
        aria-label={`${label} URL`}
        type="text"
        value={hosted ? '' : value}
        disabled={progress !== null}
        onChange={event => onChange(event.target.value)}
        placeholder={hosted ? 'File uploaded' : 'Paste an https:// URL'}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      />
      {hosted ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          File uploaded. It will appear after your project is approved.
        </p>
      ) : null}
      <label className="block text-sm text-gray-600 dark:text-gray-400">
        Upload {role === 'cover' ? 'image (up to 20 MB)' : 'video (up to 250 MB)'}
        <input
          type="file"
          accept={role === 'cover' ? '.jpg,.jpeg,.png,.gif,.webp' : '.mp4,.mov,.webm,.m4v'}
          disabled={progress !== null}
          className="mt-1 block w-full text-sm"
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
      </label>
      {hosted && progress === null ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-sm text-gray-600 underline dark:text-gray-400"
        >
          Clear file
        </button>
      ) : null}
      {progress !== null ? (
        <div className="flex items-center gap-3 text-sm">
          <progress value={progress} max={100} aria-label="Upload progress" />
          <span>{progress}%</span>
          <button type="button" onClick={() => pending.current?.abort()} className="underline">
            Cancel
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
