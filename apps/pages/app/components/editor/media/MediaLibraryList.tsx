import { useEffect, useState } from 'react';
import dayjs from 'dayjs';

import { formatBytes } from './uploadRouting.ts';

/** One READY object, as `GET /api/media/list` answers it. */
export interface MediaLibraryItem {
  id: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  /** `media://{id}` — what goes into the block. */
  ref: string;
  createdAt: string;
}

/** The kinds the list route filters by. */
export type MediaLibraryKind = 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'ARCHIVE' | 'IMAGE' | 'OTHER';

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: MediaLibraryItem[] };

/** Copy per filter, so an empty list says what it looked for. */
const NOUN: Record<MediaLibraryKind | 'ANY', string> = {
  VIDEO: 'videos',
  AUDIO: 'audio files',
  DOCUMENT: 'documents',
  ARCHIVE: 'archives',
  IMAGE: 'images',
  OTHER: 'files',
  ANY: 'files',
};

/**
 * The classroom's media, newest first, as a list to pick one from.
 *
 * Reads the shared list route on this origin (`/api/media/list`), which only
 * answers the classroom's teaching team and only lists READY objects of that
 * classroom. Shared by the picker dialog (video block, cover) and the file
 * panel's Media tab.
 */
export function MediaLibraryList({
  classroomId,
  kind,
  onPick,
  autoFocus = false,
}: {
  classroomId: string;
  kind?: MediaLibraryKind;
  onPick: (item: MediaLibraryItem) => void;
  autoFocus?: boolean;
}) {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ classroomId });
    if (kind) query.set('kind', kind);
    setState({ status: 'loading' });

    fetch(`/api/media/list?${query}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { items?: MediaLibraryItem[] };
        setState({ status: 'ready', items: Array.isArray(body.items) ? body.items : [] });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });

    return () => controller.abort();
  }, [classroomId, kind]);

  if (state.status === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500 dark:text-gray-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
        Loading…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        Media could not be loaded. Try again.
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <div className="py-8 text-center text-gray-500 dark:text-gray-400">
        <div className="font-medium">No {NOUN[kind ?? 'ANY']} in media yet</div>
      </div>
    );
  }

  return (
    <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-800">
      {state.items.map((item, index) => (
        <li key={item.id}>
          <button
            type="button"
            // The newest file is the likeliest pick, so a keyboard user lands
            // on it and can take it with one Return.
            autoFocus={autoFocus && index === 0}
            onClick={() => onPick(item)}
            className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:hover:bg-gray-800 dark:focus:bg-gray-800"
          >
            <span className="min-w-0 truncate text-sm text-gray-900 dark:text-gray-100">
              {item.filename}
            </span>
            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
              {formatBytes(item.sizeBytes)} · {dayjs(item.createdAt).format('MMM D, YYYY')}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
