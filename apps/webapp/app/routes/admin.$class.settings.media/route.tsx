import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetcher, useRevalidator } from 'react-router';
import { Button, Table } from 'antd';
import { IconUpload } from '@tabler/icons-react';
import dayjs from 'dayjs';

import { ClassmojiService } from '@classmoji/services';
import { uploadMultipart } from '@classmoji/ui-components/upload';

import { TableActionButtons } from '~/components';
import MediaUploadDialog from '~/components/features/media/MediaUploadDialog';
import { formatBytes } from '~/components/features/media/mediaUploadOptions';
import {
  MEDIA_STATE_CHIP,
  isActionable,
  mediaState,
  meterReading,
  orderForDisplay,
} from '~/components/features/media/mediaState';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { loadMediaPage, type MediaListItem } from './mediaPage.server';
import type { Route } from './+types/route';

/**
 * Settings → Media: what this classroom is storing, and the only place to add
 * to it or take something out.
 *
 * Owner-only, like the rest of `/admin/:class/settings`. The upload itself does
 * not pass through this route at all — the dialog talks to `/api/media`, which
 * hands the browser presigned URLs and takes the bytes straight to storage —
 * so what is left here is the reading, the two small mutations, and the states
 * an owner needs in order to decide what to delete.
 */

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Pro is deliberately NOT asserted here. `assertProTier` would 403 the whole
  // tab, and a free classroom is supposed to SEE this page: an empty meter and
  // a line saying what Pro would give them is the point of showing it at all.
  // Uploading is gated where it is enforced — the service refuses `createUpload`
  // with PRO_REQUIRED, whoever asks.
  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MEDIA',
    action: 'view_media',
  });

  return loadMediaPage(classroom);
};

/**
 * One job: mint a download URL for one object.
 *
 * Per row, on click, rather than for the whole list in the loader. A
 * download-tier URL is a short-lived one-shot, so minting one for every row on
 * every page load would spend a signature per file per visit and hand the
 * client a page full of credentials it will almost all throw away.
 *
 * Failure comes back as `{ error }` with a 200 on purpose: a fetcher treats a
 * 4xx as a thrown error and takes the whole page to the error boundary, and
 * "that file could not be prepared" belongs beside the row, not instead of it.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MEDIA',
    action: 'download_media',
  });

  const body = (await request.json()) as { mediaId?: unknown };
  const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';

  // Scoped to the classroom by the query itself, so an id from elsewhere is
  // simply absent rather than found and then refused.
  const row = mediaId ? await ClassmojiService.media.findMediaRow(classroom.id, mediaId) : null;
  if (!row || row.status !== 'READY') return { error: 'That file is no longer available.' };

  const url = await ClassmojiService.contentDelivery.mediaDownloadUrl({
    classroom,
    record: ClassmojiService.media.toMediaRecord(row),
    // Teaching staff always get a download, whatever the uploader chose for
    // students — `allow_download` is about the student-facing button.
    forStudent: false,
  });

  return url ? { url } : { error: 'Downloads are not configured for this classroom.' };
};

/** used / quota, and the bar that turns red before an owner is surprised. */
const UsageMeter = ({
  usedBytes,
  quotaBytes,
  isPro,
}: {
  usedBytes: number;
  quotaBytes: number;
  isPro: boolean;
}) => {
  const { percent, isFull } = meterReading(usedBytes, quotaBytes);

  return (
    <div className="mb-6">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-ink-0">
          {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used
        </span>
        {isPro && (
          <span className={`text-xs ${isFull ? 'text-red-600 dark:text-red-400' : 'text-ink-3'}`}>
            {Math.round(percent)}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-2 w-full overflow-hidden rounded-full bg-line"
      >
        <div
          className={`h-full rounded-full ${isFull ? 'bg-red-500' : 'bg-primary'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

export default function MediaSettings({ loaderData }: Route.ComponentProps) {
  const { classroomId, configured, canDeliver, usage, proQuotaBytes, items } = loaderData;
  // Every precondition the service checks before it will open an upload. The
  // button is hidden rather than disabled when one of them fails: there is a
  // line below saying which, and a dead control with no explanation beside it
  // is the version that gets clicked anyway.
  const canUpload = configured && usage.isPro && canDeliver;
  const { revalidate } = useRevalidator();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const download = useFetcher<{ url?: string; error?: string }>();
  // Each mint is a different URL, so the last one consumed is enough to stop
  // an unrelated re-render from starting the same download twice.
  const consumed = useRef<string | null>(null);

  useEffect(() => {
    const result = download.data;
    if (!result || download.state !== 'idle') return;
    setDownloadingId(null);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    if (result.url && consumed.current !== result.url) {
      consumed.current = result.url;
      // The response carries `Content-Disposition: attachment`, so the browser
      // downloads and stays on this page rather than navigating to it.
      window.location.assign(result.url);
    }
  }, [download.data, download.state]);

  const startDownload = useCallback(
    (mediaId: string) => {
      setNotice(null);
      setDownloadingId(mediaId);
      download.submit({ mediaId }, { method: 'post', encType: 'application/json' });
    },
    [download]
  );

  /**
   * Delete goes to `/api/media/:id` with a plain fetch rather than a fetcher.
   *
   * A fetcher turns any 4xx from that route into a thrown error and replaces
   * this page with the error boundary — and the interesting answers here are
   * all 4xx: 404 for something a second tab already deleted, 403 for a
   * classroom that has just been locked. Reading the status lets the row say so
   * and the list refresh, which is what an owner wants either way.
   */
  const remove = useCallback(
    async (id: string) => {
      setNotice(null);
      try {
        const response = await fetch(`/api/media/${id}`, { method: 'DELETE' });
        // 404 means another tab got there first, which is the outcome asked for.
        if (!response.ok && response.status !== 404) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          setNotice(body.message ?? 'That file could not be deleted.');
        }
      } catch {
        setNotice('That file could not be deleted. Check your connection and try again.');
      } finally {
        revalidate();
      }
    },
    [revalidate]
  );

  const columns = [
    {
      title: 'Name',
      dataIndex: 'filename',
      key: 'filename',
      render: (filename: string, row: MediaListItem) => {
        const state = mediaState(row);
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-ink-0">{filename}</span>
            <span className={`chip shrink-0 ${MEDIA_STATE_CHIP[state]}`}>{state}</span>
          </div>
        );
      },
    },
    {
      title: 'Kind',
      dataIndex: 'kind',
      key: 'kind',
      render: (kind: string) => <span className="text-ink-2">{kind.toLowerCase()}</span>,
    },
    {
      title: 'Size',
      dataIndex: 'billedBytes',
      key: 'size',
      render: (bytes: number) => <span className="text-ink-2">{formatBytes(bytes)}</span>,
    },
    {
      title: 'Uploaded by',
      dataIndex: 'uploadedByName',
      key: 'uploadedByName',
      render: (name: string) => <span className="text-ink-2">{name}</span>,
    },
    {
      title: 'Added',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (iso: string) => (
        <span className="whitespace-nowrap text-ink-3">{dayjs(iso).format('MMM D, YYYY')}</span>
      ),
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, row: MediaListItem) => (
        <TableActionButtons
          onDelete={() => remove(row.id)}
          deleteConfirmTitle="Delete file"
          deleteConfirmDescription="Anything pointing at this file will show as missing. This cannot be undone."
        >
          {isActionable(row) && (
            <button
              type="button"
              aria-label="Download"
              disabled={downloadingId === row.id}
              onClick={() => startDownload(row.id)}
              className="cursor-pointer text-gray-600 hover:text-gray-800 disabled:cursor-wait dark:text-gray-300 dark:hover:text-gray-100"
            >
              {downloadingId === row.id ? 'Preparing…' : 'Download'}
            </button>
          )}
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-0">Media</h2>
          <p className="text-sm text-ink-3">
            Video, audio, documents and archives that are too big for the content repository.
          </p>
        </div>
        {canUpload && (
          <Button
            type="primary"
            icon={<IconUpload size={16} />}
            onClick={() => setDialogOpen(true)}
            className="shrink-0"
          >
            Upload
          </Button>
        )}
      </div>

      <UsageMeter usedBytes={usage.usedBytes} quotaBytes={usage.quotaBytes} isPro={usage.isPro} />

      {!usage.isPro && (
        <p className="mb-5 rounded-xl bg-sky-bg px-4 py-3 text-sm text-sky-ink ring-1 ring-sky-bord">
          Media storage is a Pro feature. Upgrading gives this classroom{' '}
          {formatBytes(proQuotaBytes)} for lecture recordings and other files that are too large for
          the content repository.
        </p>
      )}

      {usage.isPro && !configured && (
        <p className="mb-5 rounded-xl bg-amber-bg px-4 py-3 text-sm text-amber-ink ring-1 ring-amber-bord">
          Media storage is not configured in this environment, so nothing new can be uploaded here.
        </p>
      )}

      {usage.isPro && configured && !canDeliver && (
        // The deployment is fine and the classroom is on Pro; it is this class
        // that has nowhere to serve from, which is a state an owner can fix.
        <p className="mb-5 rounded-xl bg-amber-bg px-4 py-3 text-sm text-amber-ink ring-1 ring-amber-bord">
          Media can&rsquo;t be served for this class yet — content delivery isn&rsquo;t active.
        </p>
      )}

      {notice && (
        <p className="mb-5 rounded-xl bg-peach-bg px-4 py-3 text-sm text-peach-ink ring-1 ring-peach-bord">
          {notice}
        </p>
      )}

      <Table
        columns={columns}
        dataSource={orderForDisplay(items)}
        rowKey={(row: MediaListItem) => row.id}
        rowHoverable={false}
        size="middle"
        scroll={{ x: 'max-content' }}
        pagination={items.length > 25 ? { pageSize: 25 } : false}
        locale={{
          emptyText: (
            <div className="py-12 text-center text-gray-500">
              <div className="font-medium">Nothing stored yet</div>
              <div className="text-sm">
                {usage.isPro
                  ? 'Upload a lecture recording or a file too large for the content repository.'
                  : 'Media storage is available on Pro.'}
              </div>
            </div>
          ),
        }}
      />

      <MediaUploadDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        classroomId={classroomId}
        quota={usage}
        upload={uploadMultipart}
        onUploaded={() => revalidate()}
      />
    </div>
  );
}
