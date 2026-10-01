import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Modal, theme } from 'antd';
import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import { listClassroomVideos, type MediaPickItem } from '~/utils/mediaClient';
import { formatSize } from '~/utils/mediaUpload';

/**
 * "Choose from media": the classroom's finished videos, newest first.
 *
 * Only READY rows of THIS classroom come back from the list route (the query is
 * scoped in SQL), so anything shown here is something the deck can play.
 */
export function MediaPickerDialog({
  open,
  classroomId,
  onClose,
  onPick,
}: {
  open: boolean;
  classroomId: string;
  onClose: () => void;
  onPick: (item: MediaPickItem) => void;
}) {
  const isDark = useIsDarkMode();
  const [items, setItems] = useState<MediaPickItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setFailed(false);
    listClassroomVideos(classroomId)
      .then(found => {
        if (!cancelled) setItems(found);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, classroomId]);

  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <Modal
        open={open}
        title="Choose from media"
        onCancel={onClose}
        destroyOnHidden
        footer={[
          <Button key="close" onClick={onClose}>
            Cancel
          </Button>,
        ]}
      >
        {failed ? (
          <p role="alert" className="py-6 text-center text-sm text-[var(--rose-ink)]">
            Couldn&apos;t load this class&apos;s media. Try again.
          </p>
        ) : items === null ? (
          <p className="py-6 text-center text-sm text-[var(--ink-3)]">Loading…</p>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-[var(--ink-3)]">
            <div className="font-medium">No videos yet</div>
            <div className="text-sm">Videos you upload to this class appear here.</div>
          </div>
        ) : (
          <ul className="max-h-80 divide-y divide-[var(--line)] overflow-y-auto rounded-[10px] border border-[var(--line)]">
            {items.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onPick(item)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[var(--panel-tint)]"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-[var(--ink-0)]">
                    {item.filename}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--ink-3)]">
                    {formatSize(item.sizeBytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </ConfigProvider>
  );
}

export default MediaPickerDialog;
