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
  /**
   * Signed in. Optional: a loader that does not send it is read as
   * `canCheck` (only a reader known to be signed out gets the sign-in link).
   */
  signedIn?: boolean;
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

/**
 * An unlock under way:
 * - `pending`: the POST is out;
 * - `reloading`: recorded; the page is being loaded again for the body;
 * - `arrived`: the page came back; the viewer puts the body in and settles it
 *   (`settleOpen`).
 */
export type UnlockStatus = 'pending' | 'reloading' | 'arrived';

export interface ReaderSectionsValue {
  /** False until the loader sends `readerSections` (then: no checkboxes, bodies as sent). */
  known: boolean;
  pageId: string;
  staff: boolean;
  /** Signed in (a signed-out reader sees each locked section as a sign-in link). */
  signedIn: boolean;
  /** Where a signed-out reader signs in (`signInUrl` from the loader), else null. */
  signInUrl: string | null;
  canCheck: boolean;
  canUnlock: boolean;
  /** Ticked headings, with ticks in flight applied. */
  checked: ReadonlySet<string>;
  toggleCheck: (blockId: string) => void;
  /** This reader's unlocks: the loader's, plus the ones answered in this visit. */
  unlocked: Readonly<Record<string, string>>;
  /**
   * The loader's unlocks alone: the ones the current `content` was built
   * with. The loader keeps a locked section's body exactly for these ids, so
   * an id here whose block in `content` has no children is a section with no
   * body, not one withheld from this reader.
   */
  contentUnlocked: Readonly<Record<string, string>>;
  /** Unlocks under way (the card stays, glass broken, until settled). */
  status: Readonly<Record<string, UnlockStatus>>;
  /** Record an unlock (POST on completion of the hold, never before). */
  unlock: (blockId: string) => void;
  /**
   * The viewer, once the reloaded page is in (`status` `arrived`): `true` when
   * the section is open now (its body is in the editor, or it has none),
   * `false` when the page came back without it (the reader is told; the card
   * stays).
   */
  settleOpen: (blockId: string, opened: boolean) => void;
  /** True once per block unlocked in this visit, so its body animates in once. */
  takeJustUnlocked: (blockId: string) => boolean;
}

const NOTHING: ReadonlySet<string> = new Set();
const NO_UNLOCKS: Readonly<Record<string, string>> = Object.freeze({});

export const NO_READER_SECTIONS: ReaderSectionsValue = {
  known: false,
  pageId: '',
  staff: false,
  signedIn: false,
  signInUrl: null,
  canCheck: false,
  canUnlock: false,
  checked: NOTHING,
  toggleCheck: () => {},
  unlocked: NO_UNLOCKS,
  contentUnlocked: NO_UNLOCKS,
  status: {},
  unlock: () => {},
  settleOpen: () => {},
  takeJustUnlocked: () => false,
};

export const ReaderSectionsContext = createContext<ReaderSectionsValue>(NO_READER_SECTIONS);

export function useReaderSections(): ReaderSectionsValue {
  return useContext(ReaderSectionsContext);
}

const API = '/api/page-sections';
const CHECK_FAILED = 'Couldn’t save that. Try again.';
const UNLOCK_FAILED = 'Couldn’t unlock this section. Try again.';
const OPEN_FAILED = 'Couldn’t open this section. Reload the page.';

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
 * back with the section's body in it, the viewer inserts it and settles the
 * unlock (`settleOpen`), and only then does the section show as unlocked.
 */
export function useReaderSectionsState(
  pageId: string,
  readerSections: ReaderSections | null | undefined,
  signInUrl: string | null = null
): ReaderSectionsValue {
  const known = Boolean(readerSections);
  const staff = readerSections?.staff === true;
  const canCheck = readerSections?.canCheck === true;
  const signedIn =
    typeof readerSections?.signedIn === 'boolean' ? readerSections.signedIn : canCheck;
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
  const contentUnlocked = loaderUnlocked ?? NO_UNLOCKS;
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const unlocked = useMemo(
    () => ({ ...(loaderUnlocked ?? {}), ...answered }),
    [loaderUnlocked, answered]
  );
  // POSTs out, and recorded unlocks waiting for the reloaded page (with the
  // loader payload they were recorded against: a different one is the reload).
  const [posting, setPosting] = useState<Record<string, true>>({});
  const [reloading, setReloading] = useState<Record<string, ReaderSections | null | undefined>>({});
  const status = useMemo(() => {
    const out: Record<string, UnlockStatus> = {};
    for (const id of Object.keys(posting)) out[id] = 'pending';
    for (const [id, base] of Object.entries(reloading)) {
      out[id] = base === readerSections ? 'reloading' : 'arrived';
    }
    return out;
  }, [posting, reloading, readerSections]);
  const justUnlocked = useRef(new Set<string>());

  // A different page: nothing of the last one's local state carries over.
  const [seenPage, setSeenPage] = useState(pageId);
  if (seenPage !== pageId) {
    setSeenPage(pageId);
    setInFlight(new Map());
    setAnswered({});
    setPosting({});
    setReloading({});
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
  const readerSectionsRef = useRef(readerSections);
  readerSectionsRef.current = readerSections;

  const settleOpen = useCallback((blockId: string, opened: boolean) => {
    if (!statusRef.current[blockId] || statusRef.current[blockId] === 'pending') return;
    statusRef.current = { ...statusRef.current };
    delete statusRef.current[blockId];
    setReloading(prev => {
      if (!(blockId in prev)) return prev;
      const { [blockId]: _done, ...rest } = prev;
      return rest;
    });
    if (!opened) {
      justUnlocked.current.delete(blockId);
      toast.error(OPEN_FAILED);
    }
  }, []);

  const unlock = useCallback(
    (blockId: string) => {
      if (!canUnlock || !pageId || statusRef.current[blockId]) return;
      statusRef.current = { ...statusRef.current, [blockId]: 'pending' };
      setPosting(prev => ({ ...prev, [blockId]: true }));
      const posted = () =>
        setPosting(prev => {
          if (!prev[blockId]) return prev;
          const { [blockId]: _done, ...rest } = prev;
          return rest;
        });

      fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pageId, blockId, intent: 'unlock' }),
      })
        .then(async response => {
          const body = (await response.json().catch(() => null)) as SectionsResponse | null;
          if (!response.ok || body?.ok !== true) {
            posted();
            toast.error(UNLOCK_FAILED);
            return;
          }
          const at =
            typeof body.unlockedAt === 'string' ? body.unlockedAt : new Date().toISOString();
          // Recorded. The body reaches the reader only through the page
          // loader: reload the route, and the section stays a (broken) card
          // until the viewer has put the body in and calls `settleOpen`.
          justUnlocked.current.add(blockId);
          setAnswered(prev => ({ ...prev, [blockId]: at }));
          setReloading(prev => ({ ...prev, [blockId]: readerSectionsRef.current }));
          statusRef.current = { ...statusRef.current, [blockId]: 'reloading' };
          posted();
          try {
            await revalidateRef.current();
          } catch {
            // The unlock is recorded, but this page did not get the body.
            settleOpen(blockId, false);
          }
        })
        .catch(() => {
          posted();
          toast.error(UNLOCK_FAILED);
        });
    },
    [canUnlock, pageId, settleOpen]
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
      signedIn,
      signInUrl,
      canCheck,
      canUnlock,
      checked,
      toggleCheck,
      unlocked,
      contentUnlocked,
      status,
      unlock,
      settleOpen,
      takeJustUnlocked,
    }),
    [
      known,
      pageId,
      staff,
      signedIn,
      signInUrl,
      canCheck,
      canUnlock,
      checked,
      toggleCheck,
      unlocked,
      contentUnlocked,
      status,
      unlock,
      settleOpen,
      takeJustUnlocked,
    ]
  );

  return value;
}
