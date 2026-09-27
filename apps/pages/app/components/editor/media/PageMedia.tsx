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
  MediaLibraryList,
  type MediaLibraryItem,
  type MediaLibraryKind,
} from './MediaLibraryList.tsx';

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
}

const NO_MEDIA: PageMediaApi = {
  canUseMedia: false,
  classroomId: null,
  choose: async () => null,
  place: async () => {},
};

const PageMediaContext = createContext<PageMediaApi>(NO_MEDIA);

export const usePageMedia = () => useContext(PageMediaContext);

type PickRequest = {
  kind?: MediaLibraryKind;
  resolve: (item: MediaLibraryItem | null) => void;
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

  const pick = useCallback(
    async (item: MediaLibraryItem) => {
      if (!request) return;
      setPlacing(true);
      try {
        await place(item.ref);
      } finally {
        setPlacing(false);
      }
      request.resolve(item);
      setRequest(null);
    },
    [request, place]
  );

  const canUseMedia = enabled && Boolean(classroomId);
  const api = useMemo<PageMediaApi>(
    () => ({ canUseMedia, classroomId: classroomId ?? null, choose, place }),
    [canUseMedia, classroomId, choose, place]
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
    </PageMediaContext.Provider>
  );
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
      const focusable = panel.querySelectorAll<HTMLElement>('button:not([disabled])');
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
  }, [onClose]);

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
        <div className={`px-2 pb-2 ${busy ? 'pointer-events-none opacity-60' : ''}`}>
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
