import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRevalidator } from 'react-router';
import { toast } from 'react-toastify';

/**
 * A reader's own state on one page's sections: which checkable headings they
 * ticked and which locked sections they opened (`readerSections` from the page
 * loader, API contract in the page-sections plan).
 *
 * The state lives in the ROUTE (`useReaderSectionsState`), not in the viewer:
 * the viewer is rebuilt on an asset retry (`key` epoch) and an unlock in flight
 * must survive that. The viewer hands the value to its blocks through
 * `ReaderSectionsContext` (BlockNote portals every block render into the
 * `BlockNoteView` tree, so a provider above the view reaches them).
 */
export interface ReaderSections {
  /** Reveal-all reader (teaching team): bodies present, no lock UI, nothing recorded. */
  staff: boolean;
  /** Signed in, accepted member, not impersonated: may tick headings. */
  canCheck: boolean;
  /** `canCheck && !staff`: may unlock. */
  canUnlock: boolean;
  /** This reader's ticked heading ids on this page. */
  checked: string[];
  /** This reader's opened locked sections: block id → ISO time. */
  unlocked: Record<string, string>;
}

/** Unlock counts for the editor's chip (`sectionStats`, OWNER/TEACHER only). */
export interface SectionStats {
  students: number;
  unlocks: Record<string, number>;
}

/** An unlock in flight, or recorded and waiting for the revalidated page. */
export type UnlockStatus = 'pending';

export interface ReaderSectionsValue {
  /** False until the loader sends `readerSections` (then: no checkboxes, bodies as sent). */
  known: boolean;
  pageId: string;
  staff: boolean;
  canCheck: boolean;
  canUnlock: boolean;
  /** Ticked headings, with ticks in flight applied. */
  checked: ReadonlySet<string>;
  toggleCheck: (blockId: string) => void;
  unlocked: Readonly<Record<string, string>>;
  /** Unlocks waiting for the server (the card keeps its glass off meanwhile). */
  status: Readonly<Record<string, UnlockStatus>>;
  /** Record an unlock (POST on completion of the hold, never before). */
  unlock: (blockId: string) => void;
  /** True once per block unlocked in this visit, so its body animates in once. */
  takeJustUnlocked: (blockId: string) => boolean;
}

const NOTHING: ReadonlySet<string> = new Set();

export const NO_READER_SECTIONS: ReaderSectionsValue = {
  known: false,
  pageId: '',
  staff: false,
  canCheck: false,
  canUnlock: false,
  checked: NOTHING,
  toggleCheck: () => {},
  unlocked: {},
  status: {},
  unlock: () => {},
  takeJustUnlocked: () => false,
};

export const ReaderSectionsContext = createContext<ReaderSectionsValue>(NO_READER_SECTIONS);

export function useReaderSections(): ReaderSectionsValue {
  return useContext(ReaderSectionsContext);
}

const API = '/api/page-sections';
const CHECK_FAILED = 'Couldn’t save that. Try again.';
const UNLOCK_FAILED = 'Couldn’t unlock this section. Try again.';

/** The POST answer (`{ ok, checked?, unlockedAt? }` or `{ error }`). */
interface SectionsResponse {
  ok?: boolean;
  checked?: boolean;
  unlockedAt?: string;
  error?: string;
}

/**
 * The reader's state for the page in view.
 *
 * Ticks and unlocks both POST with a plain `fetch`, so any refusal or network
 * error stays here (a toast, the glass back) and never reaches the route's
 * error page. A tick changes nothing else the page shows, so it stops there.
 * A recorded unlock then revalidates the route: the loader's `content` comes
 * back with the section's body in it, and the viewer inserts it.
 */
export function useReaderSectionsState(
  pageId: string,
  readerSections: ReaderSections | null | undefined
): ReaderSectionsValue {
  const known = Boolean(readerSections);
  const staff = readerSections?.staff === true;
  const canCheck = readerSections?.canCheck === true;
  const canUnlock = readerSections?.canUnlock === true;

  // Ticks: the loader's set, plus confirmed ticks it has not reloaded yet,
  // plus ticks in flight. A new loader payload is the server's word and
  // replaces the confirmed set (in-flight ticks stay on top until answered).
  const loaderChecked = readerSections?.checked;
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set(loaderChecked ?? []));
  const [inFlight, setInFlight] = useState<Map<string, { value: boolean; seq: number }>>(
    () => new Map()
  );
  const seq = useRef(0);
  // Derived state, React's documented shape: compare with the payload last
  // seen and reset in the same render.
  const [seenLoaderChecked, setSeenLoaderChecked] = useState(loaderChecked);
  if (seenLoaderChecked !== loaderChecked) {
    setSeenLoaderChecked(loaderChecked);
    setConfirmed(new Set(loaderChecked ?? []));
  }

  const checked = useMemo(() => {
    if (inFlight.size === 0) return confirmed;
    const out = new Set(confirmed);
    for (const [id, { value }] of inFlight) {
      if (value) out.add(id);
      else out.delete(id);
    }
    return out;
  }, [confirmed, inFlight]);
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  const toggleCheck = useCallback(
    (blockId: string) => {
      if (!canCheck || !pageId) return;
      const value = !checkedRef.current.has(blockId);
      const mine = ++seq.current;
      setInFlight(prev => new Map(prev).set(blockId, { value, seq: mine }));
      const settle = (ok: boolean) => {
        setInFlight(prev => {
          if (prev.get(blockId)?.seq !== mine) return prev;
          const next = new Map(prev);
          next.delete(blockId);
          return next;
        });
        if (ok) {
          setConfirmed(prev => {
            const next = new Set(prev);
            if (value) next.add(blockId);
            else next.delete(blockId);
            return next;
          });
        } else {
          toast.error(CHECK_FAILED);
        }
      };
      fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pageId, blockId, intent: value ? 'check' : 'uncheck' }),
      })
        .then(async response => {
          const body = (await response.json().catch(() => null)) as SectionsResponse | null;
          settle(response.ok && body?.ok === true);
        })
        .catch(() => settle(false));
    },
    [canCheck, pageId]
  );

  // Unlocks: the loader's, plus the ones answered in this visit.
  const loaderUnlocked = readerSections?.unlocked;
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const unlocked = useMemo(
    () => ({ ...(loaderUnlocked ?? {}), ...answered }),
    [loaderUnlocked, answered]
  );
  const [status, setStatus] = useState<Record<string, UnlockStatus>>({});
  const justUnlocked = useRef(new Set<string>());

  // A different page: nothing of the last one's local state carries over.
  const [seenPage, setSeenPage] = useState(pageId);
  if (seenPage !== pageId) {
    setSeenPage(pageId);
    setInFlight(new Map());
    setAnswered({});
    setStatus({});
  }
  useEffect(() => {
    justUnlocked.current.clear();
  }, [pageId]);

  // `revalidate` is read through a ref: the revalidator's identity changes
  // with its state, and `unlock` should not.
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;
  const statusRef = useRef(status);
  statusRef.current = status;

  const unlock = useCallback(
    (blockId: string) => {
      if (!canUnlock || !pageId || statusRef.current[blockId]) return;
      setStatus(prev => ({ ...prev, [blockId]: 'pending' }));

      const finish = (unlockedAt: string | null) => {
        if (unlockedAt) {
          justUnlocked.current.add(blockId);
          setAnswered(prev => ({ ...prev, [blockId]: unlockedAt }));
        } else {
          toast.error(UNLOCK_FAILED);
        }
        setStatus(prev => {
          if (!prev[blockId]) return prev;
          const { [blockId]: _done, ...rest } = prev;
          return rest;
        });
      };

      fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pageId, blockId, intent: 'unlock' }),
      })
        .then(async response => {
          const body = (await response.json().catch(() => null)) as SectionsResponse | null;
          if (!response.ok || body?.ok !== true) return finish(null);
          const at =
            typeof body.unlockedAt === 'string' ? body.unlockedAt : new Date().toISOString();
          // Recorded. The card stays broken open (placeholder lines) until the
          // page has the body: the loader re-runs, the viewer inserts the
          // children, then the section opens.
          // A failed revalidation still leaves the unlock recorded; the body
          // arrives with the next load.
          try {
            await revalidateRef.current();
          } catch {
            // Nothing to undo.
          }
          finish(at);
        })
        .catch(() => finish(null));
    },
    [canUnlock, pageId]
  );

  const takeJustUnlocked = useCallback((blockId: string) => {
    if (!justUnlocked.current.has(blockId)) return false;
    justUnlocked.current.delete(blockId);
    return true;
  }, []);

  const value = useMemo<ReaderSectionsValue>(
    () => ({
      known,
      pageId,
      staff,
      canCheck,
      canUnlock,
      checked,
      toggleCheck,
      unlocked,
      status,
      unlock,
      takeJustUnlocked,
    }),
    [
      known,
      pageId,
      staff,
      canCheck,
      canUnlock,
      checked,
      toggleCheck,
      unlocked,
      status,
      unlock,
      takeJustUnlocked,
    ]
  );

  return value;
}
