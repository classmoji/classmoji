import { IconDownload } from '@tabler/icons-react';

import { useMediaDownloadHref } from '~/hooks/useMediaDownloads.ts';

/**
 * The reader's download button for a media file, or nothing.
 *
 * Whether there is one is the page loader's decision (see `mediaDownloads`):
 * a member, and a file the uploader let students download — or any non-video
 * file, or any file for the teaching team. The link goes to
 * `/api/media-download`, which mints the URL at the moment of the click.
 */
export function MediaDownloadLink({ fileRef }: { fileRef: unknown }) {
  const href = useMediaDownloadHref(fileRef);
  if (!href) return null;
  return (
    <a
      className="media-download-link"
      href={href}
      rel="nofollow"
      contentEditable={false}
      draggable={false}
    >
      <IconDownload size={14} aria-hidden="true" />
      Download
    </a>
  );
}
