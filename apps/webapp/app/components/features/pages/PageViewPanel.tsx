import { useCallback, useEffect, useRef, useState } from 'react';
import { IconExternalLink, IconX } from '@tabler/icons-react';
import { Tooltip } from 'antd';
import { useDarkMode } from '~/hooks';
import { buildEmbedUrl, originOf, readPagesMessage, type PageNavMessage } from './pageLinks';

/**
 * ONE page reader, two containers.
 *
 * This is the panel from the approved mockups (S5 / S5b): a header row (page
 * title, optional ↗, optional ✕) over an iframe of the pages app in embed
 * mode. The peek drawer and the docked Pages view render the SAME component —
 * the only difference is the box around it, which is the whole point of the
 * design: a linked page and the Pages destination are one surface, so reading
 * one never teaches you a second set of controls.
 *
 * The iframe src is set once per "explicit" navigation and then left alone:
 * once the embedded app follows a hub link, its history belongs to it. Forcing
 * `src` from React state on every render would yank the reader back to where
 * the panel was opened.
 */

export interface PageViewPanelProps {
  /** Origin of the pages app (PAGES_URL), from the loader. */
  pagesUrl: string;
  classSlug: string;
  /** Page id (or site slug) the panel opens on. */
  pageRef: string;
  /** Header title. Updated by nav pings from the embedded document. */
  title: string;
  /** Where ↗ opens. Omit to hide the button entirely (no site, no fallback). */
  openTarget?: { url: string; isSite: boolean } | null;
  /** Drawer only — renders the ✕ button. */
  onClose?: () => void;
  /** The embedded document navigated itself. */
  onNav?: (message: PageNavMessage) => void;
  /** Escape pressed while focus was inside the iframe. */
  onEsc?: () => void;
  /**
   * Docked only: the class front page. When set and the reader has wandered
   * off it, the header title becomes a "back to the front page" control —
   * "the header title doubles as home" from the S5b notes.
   */
  homeRef?: string | null;
  homeTitle?: string | null;
  variant: 'drawer' | 'docked';
}

const PageViewPanel = ({
  pagesUrl,
  classSlug,
  pageRef,
  title,
  openTarget,
  onClose,
  onNav,
  onEsc,
  homeRef = null,
  homeTitle = null,
  variant,
}: PageViewPanelProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  // The reader's own origin, so the embedded app can verify who embedded it.
  // Read lazily: `window` does not exist during the server render.
  const [parentOrigin, setParentOrigin] = useState<string | null>(null);
  useEffect(() => setParentOrigin(window.location.origin), []);

  // The app's RESOLVED appearance, handed to the iframe so it matches the app
  // rather than the OS. `isDarkMode` has already collapsed 'system' to a
  // boolean, so this is only ever 'light' or 'dark'.
  const { isDarkMode } = useDarkMode();
  const theme = isDarkMode ? 'dark' : 'light';

  // The page the panel has been EXPLICITLY pointed at. Distinct from wherever
  // the embedded app has since navigated itself: re-deriving src from the
  // latter on every nav ping would fight the reader's own history.
  const [targetRef, setTargetRef] = useState(pageRef);
  // Where the reader actually IS, which only nav pings can tell us — the iframe
  // is cross-origin, so its location is otherwise invisible from here.
  const [currentRef, setCurrentRef] = useState(pageRef);
  // Bumped to force a reload when the src string would be unchanged (sending a
  // wandered-off reader back to a home page it was originally opened on).
  const [reloadNonce, setReloadNonce] = useState(0);

  // Re-point when the container asks for a different page (a second link
  // clicked while the drawer is open, or a deep-link navigation).
  useEffect(() => {
    setTargetRef(pageRef);
    setCurrentRef(pageRef);
    setLoaded(false);
  }, [pageRef]);

  // Held back until the origin is known so the iframe loads exactly once —
  // rendering a src-without-parentOrigin first would cost a wasted page load
  // and a flash, and the bridge would be dead for that first document.
  const src = parentOrigin
    ? buildEmbedUrl({ pagesUrl, classSlug, pageRef: targetRef, parentOrigin, theme })
    : null;

  const pagesOrigin = originOf(pagesUrl);

  // Nav + Escape pings from the embedded document. Every one is checked against
  // the pages origin, this exact frame, and this classroom before it is
  // believed — see readPagesMessage.
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      // No frame yet means nothing of ours can legitimately be talking, and the
      // source check below would be vacuous — refuse rather than half-check.
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow) return;

      const message = readPagesMessage(event, { pagesOrigin, frameWindow, classSlug });
      if (!message) return;
      if (message.type === 'classmoji:page-esc') {
        onEsc?.();
        return;
      }
      setCurrentRef(message.pageId);
      onNav?.(message);
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [pagesOrigin, classSlug, onNav, onEsc]);

  const goHome = useCallback(() => {
    if (!homeRef) return;
    setTargetRef(homeRef);
    setCurrentRef(homeRef);
    // The reader wandered off inside the iframe, so `src` may already be the
    // home URL. Changing the iframe's key is what actually re-mounts it.
    setReloadNonce(n => n + 1);
    setLoaded(false);
  }, [homeRef]);

  const isDocked = variant === 'docked';
  // Driven by where the reader IS, not by where the panel was pointed — the two
  // diverge the moment a hub link is clicked, which is exactly when this
  // control needs to appear.
  const canGoHome = isDocked && !!homeRef && currentRef !== homeRef;

  return (
    <div className="flex h-full min-h-0 flex-col" data-cm-page-panel={variant}>
      {/* Header: title + actions. Matches the mockup's peek-head in both
          containers; the docked one simply has no ✕. */}
      <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-2.5 dark:border-neutral-800">
        {canGoHome ? (
          // Docked, off the front page: a flat two-level "Home › {current}"
          // crumb. "Home" navigates the iframe back to the front page (goHome);
          // the current title is the terminal, non-interactive crumb. The peek
          // drawer never reaches here — it passes no homeRef, so canGoHome is
          // false and it keeps the plain title below.
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <button
              type="button"
              onClick={goHome}
              title={`Back to ${homeTitle || 'the front page'}`}
              className="flex-none font-semibold text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
            >
              Home
            </button>
            <span aria-hidden="true" className="flex-none text-gray-400 dark:text-gray-600">
              ›
            </span>
            <span
              aria-current="page"
              className="truncate font-semibold text-gray-700 dark:text-gray-200"
            >
              {title}
            </span>
          </nav>
        ) : (
          <h2 className="truncate text-sm font-semibold text-gray-700 dark:text-gray-200">
            {title}
          </h2>
        )}

        <div className="ml-auto flex flex-none items-center gap-1.5">
          {openTarget?.url ? (
            <Tooltip
              title={openTarget.isSite ? 'Open on the course website' : 'Open full page'}
              placement="bottom"
            >
              <a
                href={openTarget.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={openTarget.isSite ? 'Open on the course website' : 'Open full page'}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800 dark:border-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
              >
                <IconExternalLink size={15} strokeWidth={1.9} />
              </a>
            </Tooltip>
          ) : null}

          {onClose ? (
            <Tooltip title="Close (Esc)" placement="bottom">
              <button
                type="button"
                onClick={onClose}
                aria-label="Close page preview"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800 dark:border-neutral-700 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
              >
                <IconX size={15} strokeWidth={1.9} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {/* Body: the page itself, scrolling inside the panel. */}
      <div className="relative min-h-0 flex-1">
        {!loaded && (
          <div
            className="absolute inset-0 z-10 animate-pulse space-y-3 bg-white p-6 dark:bg-neutral-900"
            aria-hidden="true"
          >
            <div className="h-28 w-full rounded-xl bg-gray-100 dark:bg-neutral-800" />
            <div className="h-6 w-2/3 rounded-md bg-gray-100 dark:bg-neutral-800" />
            <div className="h-3 w-full rounded bg-gray-100 dark:bg-neutral-800" />
            <div className="h-3 w-5/6 rounded bg-gray-100 dark:bg-neutral-800" />
            <div className="h-3 w-4/6 rounded bg-gray-100 dark:bg-neutral-800" />
          </div>
        )}
        {src ? (
          <iframe
            // Theme is in the key so a live light/dark toggle re-mounts the
            // cross-origin iframe (its only channel for a theme change is the
            // src), repainting the reader to match.
            key={`${targetRef}:${theme}:${reloadNonce}`}
            ref={frameRef}
            src={src}
            title={title || 'Page'}
            onLoad={() => setLoaded(true)}
            className="h-full w-full border-0 bg-white dark:bg-neutral-900"
          />
        ) : null}
      </div>
    </div>
  );
};

export default PageViewPanel;
