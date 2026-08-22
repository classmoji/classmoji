import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import PageViewPanel from './PageViewPanel';
import {
  INITIAL_PEEK_STATE,
  inAppPageUrl,
  peekReducer,
  resolveOpenTarget,
  type PageNavMessage,
} from './pageLinks';

/**
 * The peek drawer, and the one piece of app-wide state it needs.
 *
 * Why a provider rather than local state at each link: a linked page can be
 * opened from a module tree, a repo tree or a calendar event, and the drawer
 * has to sit ABOVE the app shell in all three cases. Threading an `open` prop
 * from each of those to a top-level portal would be the same context, spelled
 * worse.
 *
 * The URL deliberately does NOT change when a page is peeked. Context
 * preservation is the entire point of Option C — a student reading the lab
 * guide mid-assignment closes the drawer and their repo tree is still there,
 * still expanded, still scrolled where they left it. Routing the drawer would
 * throw exactly that away, and is why `useRouteDrawer` is not used here.
 */

interface PagePeekContextValue {
  openPeek: (page: { pageId: string; title: string }) => void;
  closePeek: () => void;
  isOpen: boolean;
}

const PagePeekContext = createContext<PagePeekContextValue | null>(null);

/**
 * Null when no provider is mounted (admin routes, the syllabus-bot overlay at
 * the app root). Callers fall back to their ordinary link, so a surface shared
 * with admin keeps working untouched.
 */
export const usePagePeek = () => useContext(PagePeekContext);

export interface PagePeekProviderProps {
  children: React.ReactNode;
  classSlug: string;
  /** `/student` or `/assistant` — the prefix for in-app fallback links. */
  rolePath: string;
  pagesUrl: string;
  siteOrigin?: string | null;
  siteSlugByPageId?: Record<string, string>;
}

const PagePeekProvider = ({
  children,
  classSlug,
  rolePath,
  pagesUrl,
  siteOrigin = null,
  siteSlugByPageId = {},
}: PagePeekProviderProps) => {
  const [state, dispatch] = useReducer(peekReducer, INITIAL_PEEK_STATE);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus was before the drawer stole it, so Esc/✕ can put it back.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const openPeek = useCallback((page: { pageId: string; title: string }) => {
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    dispatch({ type: 'open', pageId: page.pageId, title: page.title });
  }, []);

  const closePeek = useCallback(() => {
    dispatch({ type: 'close' });
  }, []);

  const onNav = useCallback((message: PageNavMessage) => {
    dispatch({ type: 'nav', pageId: message.pageId, title: message.title });
  }, []);

  // Slide-in on the frame after mount so the transform has something to
  // animate from. `motion-reduce:` neutralises it for prefers-reduced-motion.
  useEffect(() => {
    if (!state.open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [state.open]);

  // Esc while the WEBAPP has focus. Escape pressed inside the iframe is a
  // different document entirely and arrives as a postMessage instead.
  useEffect(() => {
    if (!state.open) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePeek();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [state.open, closePeek]);

  // Scroll lock + focus handoff. Restoring focus on close matters more than
  // usual here: the thing that opened the drawer is a row in a tree the reader
  // wants to keep working through.
  useEffect(() => {
    if (!state.open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [state.open]);

  const value = useMemo<PagePeekContextValue>(
    () => ({ openPeek, closePeek, isOpen: state.open }),
    [openPeek, closePeek, state.open]
  );

  const openTarget = state.currentPageId
    ? resolveOpenTarget({
        siteOrigin,
        siteSlugByPageId,
        pageId: state.currentPageId,
        fallbackUrl: inAppPageUrl(rolePath, classSlug, state.currentPageId),
      })
    : null;

  // `document` is absent during the server render; the drawer is client-only
  // by nature (it never appears on first paint).
  const canPortal = typeof document !== 'undefined';

  return (
    <PagePeekContext.Provider value={value}>
      {children}
      {state.open && state.pageId && canPortal
        ? createPortal(
            <div className="fixed inset-0 z-[1100]" data-cm-page-peek>
              {/* Scrim — click anywhere outside to close. */}
              <button
                type="button"
                aria-label="Close page preview"
                onClick={closePeek}
                className={`absolute inset-0 cursor-default bg-gray-900/35 transition-opacity duration-200 motion-reduce:transition-none dark:bg-black/60 ${
                  entered ? 'opacity-100' : 'opacity-0'
                }`}
              />
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={state.title || 'Page preview'}
                tabIndex={-1}
                className={`absolute inset-y-0 right-0 flex w-[min(720px,90vw)] flex-col overflow-hidden rounded-l-2xl bg-white shadow-2xl outline-none ring-1 ring-stone-200 transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-neutral-900 dark:ring-neutral-800 ${
                  entered ? 'translate-x-0' : 'translate-x-full'
                }`}
              >
                <PageViewPanel
                  variant="drawer"
                  pagesUrl={pagesUrl}
                  classSlug={classSlug}
                  pageRef={state.pageId}
                  title={state.title}
                  openTarget={openTarget}
                  onClose={closePeek}
                  onNav={onNav}
                  onEsc={closePeek}
                />
              </div>
            </div>,
            document.body
          )
        : null}
    </PagePeekContext.Provider>
  );
};

export default PagePeekProvider;
