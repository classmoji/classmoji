import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DEFAULT_VIDEO_OPTIONS,
  MediaVideoOptions,
  applyVideoOption,
  type VideoOptions,
} from '@classmoji/ui-components/media-options';

import {
  MediaLibraryList,
  type MediaLibraryItem,
  type MediaLibraryKind,
} from './MediaLibraryList.tsx';
import { formatBytes } from './uploadRouting.ts';

/**
 * What an editor block may do with the classroom's media.
 *
 * Provided above `BlockNoteView` (BlockNote portals every block render into
 * this tree, which is how `AssetSrcSetContext` reaches the image block too), so
 * the video block and the file panel read it without the editor having to
 * thread props through BlockNote's schema.
 */
export interface PageMediaApi {
  /** Staff on a classroom whose media is available. False hides every media affordance. */
  canUseMedia: boolean;
  classroomId: string | null;
  /**
   * Open the picker. Resolves with the chosen object — its display URL already
   * seeded, so the block's first render has something to play — or null when
   * the person closed the picker.
   */
  choose(kind?: MediaLibraryKind): Promise<MediaLibraryItem | null>;
  /** Seed the display URL for a reference about to go into a block. */
  place(ref: string): Promise<void>;
  /**
   * Ask the uploader for a video's three options (media plan §3.10) before it
   * is sent to media. Resolves with their choice, or null when they cancelled.
   */
  askVideoOptions(file: { name: string; size: number }): Promise<VideoOptions | null>;
}

const NO_MEDIA: PageMediaApi = {
  canUseMedia: false,
  classroomId: null,
  choose: async () => null,
  place: async () => {},
  // No provider, no dialog to ask with: the plan's defaults.
  askVideoOptions: async () => ({ ...DEFAULT_VIDEO_OPTIONS }),
};

const PageMediaContext = createContext<PageMediaApi>(NO_MEDIA);

export const usePageMedia = () => useContext(PageMediaContext);

type PickRequest = {
  kind?: MediaLibraryKind;
  resolve: (item: MediaLibraryItem | null) => void;
};

type VideoOptionsRequest = {
  file: { name: string; size: number };
  resolve: (options: VideoOptions | null) => void;
};

export function PageMediaProvider({
  classroomId,
  enabled,
  place,
  children,
}: {
  classroomId: string | null | undefined;
  enabled: boolean;
  place: (ref: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const [request, setRequest] = useState<PickRequest | null>(null);
  const [placing, setPlacing] = useState(false);
  const [videoRequest, setVideoRequest] = useState<VideoOptionsRequest | null>(null);

  const askVideoOptions = useCallback(
    (file: { name: string; size: number }) =>
      new Promise<VideoOptions | null>(resolve => {
        setVideoRequest(previous => {
          // Two uploads asking at once: the first one is cancelled, so no
          // upload is left waiting on a dialog that is no longer on screen.
          previous?.resolve(null);
          return { file, resolve };
        });
      }),
    []
  );

  const answerVideoOptions = useCallback((options: VideoOptions | null) => {
    setVideoRequest(previous => {
      previous?.resolve(options);
      return null;
    });
  }, []);

  const choose = useCallback(
    (kind?: MediaLibraryKind) =>
      new Promise<MediaLibraryItem | null>(resolve => {
        setRequest(previous => {
          // A second open replaces the first; the first caller hears "closed".
          previous?.resolve(null);
          return { kind, resolve };
        });
      }),
    []
  );

  const close = useCallback(() => {
    setRequest(previous => {
      previous?.resolve(null);
      return null;
    });
  }, []);

  // A ref as well as state: a keyboard pick lands through the list's own
  // handler, not a click the overlay can swallow, and two quick Enters must
  // not both start placing — the second would read the state before the
  // first had re-rendered it.
  const placingRef = useRef(false);
  const pick = useCallback(
    async (item: MediaLibraryItem) => {
      if (!request || placingRef.current) return;
      placingRef.current = true;
      setPlacing(true);
      try {
        await place(item.ref);
      } finally {
        placingRef.current = false;
        setPlacing(false);
      }
      request.resolve(item);
      setRequest(null);
    },
    [request, place]
  );

  const canUseMedia = enabled && Boolean(classroomId);
  const api = useMemo<PageMediaApi>(
    () => ({ canUseMedia, classroomId: classroomId ?? null, choose, place, askVideoOptions }),
    [canUseMedia, classroomId, choose, place, askVideoOptions]
  );

  return (
    <PageMediaContext.Provider value={api}>
      {children}
      {canUseMedia && classroomId && request && (
        <MediaPickerDialog
          classroomId={classroomId}
          kind={request.kind}
          busy={placing}
          onPick={pick}
          onClose={close}
        />
      )}
      {videoRequest && (
        <VideoOptionsDialog
          // A fresh dialog, with fresh defaults, for every file asked about.
          key={`${videoRequest.file.name}:${videoRequest.file.size}`}
          file={videoRequest.file}
          onAnswer={answerVideoOptions}
        />
      )}
    </PageMediaContext.Provider>
  );
}

/**
 * Escape to close and Tab kept inside the panel — the pages app's hand-rolled
 * dialog idiom (see `ConfirmDialog`), shared by the two dialogs here.
 */
function useDialogKeys(panelRef: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panelRef, onClose]);
}

/**
 * The picker: the classroom's media in a dialog.
 *
 * The pages app's hand-rolled dialog idiom (see `ConfirmDialog`): overlay,
 * `role="dialog"`, Escape to close, focus kept inside. Not Mantine, which is
 * mounted only to serve BlockNote.
 */
function MediaPickerDialog({
  classroomId,
  kind,
  busy,
  onPick,
  onClose,
}: {
  classroomId: string;
  kind?: MediaLibraryKind;
  busy: boolean;
  onPick: (item: MediaLibraryItem) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogKeys(panelRef, onClose);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-picker-title"
        aria-busy={busy}
        className="relative z-10 w-full max-w-lg rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="px-5 pb-2 pt-5">
          <h2
            id="media-picker-title"
            className="text-base font-semibold text-gray-900 dark:text-white"
          >
            Choose from media
          </h2>
        </div>
        {/* `inert` while placing: no pointer AND no keyboard pick of a second
            item while the first is being placed. */}
        <div className={`px-2 pb-2 ${busy ? 'pointer-events-none opacity-60' : ''}`} inert={busy}>
          <MediaLibraryList classroomId={classroomId} kind={kind} onPick={onPick} autoFocus />
        </div>
        <div className="flex justify-end border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The three video choices, asked before a video goes to media (§3.10).
 *
 * The same component the webapp's media page shows
 * (`@classmoji/ui-components/media-options`), so a video uploaded from a page
 * is set up exactly like one uploaded from Settings → Media. Upload sends it
 * with these choices; Cancel (or Escape) sends nothing.
 */
function VideoOptionsDialog({
  file,
  onAnswer,
}: {
  file: { name: string; size: number };
  onAnswer: (options: VideoOptions | null) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const [options, setOptions] = useState<VideoOptions>({ ...DEFAULT_VIDEO_OPTIONS });
  const cancel = useCallback(() => onAnswer(null), [onAnswer]);
  useDialogKeys(panelRef, cancel);

  useEffect(() => {
    uploadRef.current?.focus();
  }, []);

  const size = formatBytes(file.size);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={cancel}
        role="presentation"
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-options-title"
        className="relative z-10 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="px-5 pb-3 pt-5">
          <h2
            id="video-options-title"
            className="text-base font-semibold text-gray-900 dark:text-white"
          >
            Upload video
          </h2>
          <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
            {file.name}
            {size ? ` · ${size}` : ''}
          </p>
        </div>
        <div className="px-5 pb-4">
          <MediaVideoOptions
            filename={file.name}
            value={options}
            onChange={(field, next) =>
              setOptions(current => applyVideoOption(current, field, next))
            }
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            ref={uploadRef}
            type="button"
            onClick={() => onAnswer(options)}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            Upload
          </button>
        </div>
      </div>
    </div>
  );
}
