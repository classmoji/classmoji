import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Modal, theme } from 'antd';
import type { MultipartUploadResult } from '@classmoji/ui-components/upload';
import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import {
  DEFAULT_VIDEO_OPTIONS,
  afterMediaFailure,
  applyVideoOption,
  formatSize,
  mediaUploadMessage,
  type UploadCapability,
  type VideoOptions,
} from '~/utils/mediaUpload';
import { MediaUploadProgress } from './MediaUploadProgress';
import { VideoOptionsFields } from './VideoOptionsFields';

/**
 * Upload one video to the classroom's media: the three choices, then the
 * upload itself with its progress, in one dialog.
 *
 * The dialog stays open until the upload has finished or been cancelled —
 * closing it mid-upload cancels, rather than leaving bytes going up behind a
 * screen that no longer says so.
 *
 * When media turns the file away and the repository can take it (the class is
 * no longer Pro, or media is unavailable, and the video fits), the dialog
 * hands it to `onUseRepo` instead of showing a refusal. A full quota is never
 * handed over: its sentence is shown as the server wrote it.
 */
export function VideoUploadDialog({
  file,
  classroomId,
  capability,
  onClose,
  onUploaded,
  onUseRepo,
}: {
  /** The picked video; the dialog is open while this is set. */
  file: File | null;
  classroomId: string;
  /** What the editor routed with, for wording a refusal. */
  capability?: UploadCapability | null;
  onClose: () => void;
  onUploaded: (result: MultipartUploadResult) => void;
  /** Take a file media turned away to the course repository instead. */
  onUseRepo?: (file: File) => void;
}) {
  const isDark = useIsDarkMode();
  const [options, setOptions] = useState<VideoOptions>(DEFAULT_VIDEO_OPTIONS);
  const upload = useMediaUpload(classroomId);
  const { clearError } = upload;

  // A fresh file starts from the defaults and with no leftover error.
  useEffect(() => {
    setOptions(DEFAULT_VIDEO_OPTIONS);
    clearError();
  }, [file, clearError]);

  const close = () => {
    upload.cancel();
    onClose();
  };

  const begin = async () => {
    if (!file) return;
    const result = await upload.start(file, options, failure => {
      const outcome = afterMediaFailure(failure, file, capability);
      if (outcome.kind === 'repo' && onUseRepo) {
        onUseRepo(file);
        return { handled: true };
      }
      return {
        message:
          outcome.kind === 'refused' ? outcome.message : mediaUploadMessage({ code: 'USE_REPO' }),
      };
    });
    if (result) onUploaded(result);
  };

  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <Modal
        open={file !== null}
        title="Upload video"
        onCancel={close}
        maskClosable={!upload.uploading}
        destroyOnHidden
        footer={
          upload.uploading
            ? null
            : [
                <Button key="cancel" onClick={close}>
                  Cancel
                </Button>,
                <Button key="upload" type="primary" onClick={begin}>
                  Upload
                </Button>,
              ]
        }
      >
        {file && (
          <div className="space-y-3">
            <p className="break-all text-sm text-[var(--ink-1)]">
              {file.name} · {formatSize(file.size)}
            </p>

            {upload.state.error && (
              <p
                role="alert"
                className="rounded-[10px] border border-[var(--rose-bord)] bg-[var(--rose-bg)] px-3 py-2 text-sm text-[var(--rose-ink)]"
              >
                {upload.state.error}
              </p>
            )}

            {upload.uploading && upload.state.file ? (
              <MediaUploadProgress
                file={upload.state.file}
                sentBytes={upload.state.sentBytes}
                onCancel={upload.cancel}
              />
            ) : (
              <VideoOptionsFields
                filename={file.name}
                value={options}
                onChange={(field, next) => setOptions(prev => applyVideoOption(prev, field, next))}
              />
            )}
          </div>
        )}
      </Modal>
    </ConfigProvider>
  );
}

export default VideoUploadDialog;
