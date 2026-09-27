import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Modal, theme } from 'antd';
import type { MultipartUploadResult } from '@classmoji/ui-components/upload';
import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  formatSize,
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
 */
export function VideoUploadDialog({
  file,
  classroomId,
  onClose,
  onUploaded,
}: {
  /** The picked video; the dialog is open while this is set. */
  file: File | null;
  classroomId: string;
  onClose: () => void;
  onUploaded: (result: MultipartUploadResult) => void;
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
    const result = await upload.start(file, options);
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
