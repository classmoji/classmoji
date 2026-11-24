import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { CommentsButton, CommentsPanel } from '~/components/comments/CommentsPanel.tsx';
import { PageDiscussion } from '~/components/comments/PageDiscussion.tsx';
import { usePageCommentsController } from '~/components/comments/usePageCommentsController.ts';
import { useAssetMap, useAssetRetry } from '~/hooks/useAssetMap.ts';
import { useReaderSectionsState } from '~/hooks/useReaderSections.tsx';
import { hashTarget } from '~/utils/headingAnchors.ts';
import type { ReaderPayload, ReaderSurfaceKind } from '~/utils/readerPayload.ts';
import { toastNotify, type ReaderNotify } from './notify.ts';
import { pageWidthClass } from './pageWidth.ts';
import { ReaderCover } from './ReaderCover.tsx';
import { ReaderSurfaceContext, type ReaderSurfaceValue } from './readerSurface.ts';

import '~/styles/page-reader.css';

const BlockNoteViewer = lazy(() => import('~/components/viewer/BlockNoteViewer.tsx'));

/**
 * PageReader — what a reader of a page sees, on every surface: the cover, the
 * title, the draft chip, the page's discussion and comments, and the document
 * in the read-only BlockNote viewer, in the page's width.
 *
 * It does NOT depend on a router (nothing in its module graph imports
 * `react-router`; `tests/unit/page-reader-graph.spec.ts` holds it to that), so
 * the same component can be mounted by the pages app's page route, by a small
 * client island on the class site, and by the MCP's page render. Everything a
 * router used to provide comes from the host:
 *   - `onRefresh` loads the page again (after an unlock, or once when a signed
 *     URL has expired). The app passes its loader revalidation and resolves
 *     with nothing (the new payload arrives as the `payload` prop); a host
 *     without a router resolves with the new payload, which replaces the
 *     content and section state in one update. A rejection is a failure (the
 *     unlock is reported as not opened).
 *   - `navigatePage` moves to another page of the classroom client-side (the
 *     app); without it the page links are plain links.
 *   - `notify`, `apiBase` and `downloadOrigin`: how failures are told and
 *     where the API and the download route live.
 *
 * The reader's own state lives here, not in the viewer (which is rebuilt on an
 * asset retry): this reader's ticks and unlocks, the comments controller, the
 * display-URL map and its one retry, and dark mode (`html.dark`).
 */

export interface PageReaderPage {
  id: string;
  title: string | null;
  width: number | null;
  is_draft: boolean;
}

export interface PageReaderProps {
  payload: ReaderPayload;
  page: PageReaderPage;
  surface: ReaderSurfaceKind;
  /** The page's classroom (for in-app page hrefs). */
  classroomSlug?: string | null;
  onRefresh?: () => Promise<ReaderPayload | void>;
  navigatePage?: ((pageId: string) => void) | null;
  notify?: ReaderNotify;
  apiBase?: string;
  downloadOrigin?: string;
  /** In a frame with no header: the comments button floats, the panel starts at the top. */
  embedded?: boolean;
  /**
   * The host's header, given the comments button to put in its actions (null
   * when there is none, or when it floats because the page is embedded).
   * Without a header the button floats.
   */
  renderHeader?: (commentsButton: ReactNode | null) => ReactNode;
  /** Host notices between the header and the cover (a staff preview's bars, notices). */
  notices?: ReactNode;
  /** A rendered staff preview: its highlight CSS and whether the cover changed. */
  preview?: { css: string | null; coverChanged: boolean } | null;
  /** Called once the document is on screen. */
  onReady?: () => void;
}

const NO_REFRESH = () => Promise.reject(new Error('This page cannot be loaded again here.'));

function LoadingContent() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
    </div>
  );
}

/** The payload in effect: the host's, or the one a refresh returned for it. */
interface RefreshedPayload {
  /** The host payload and page this refresh answered; another one replaces it. */
  base: ReaderPayload;
  pageId: string;
  payload: ReaderPayload;
}

export function PageReader({
  payload,
  page,
  surface,
  classroomSlug = null,
  onRefresh,
  navigatePage = null,
  notify = toastNotify,
  apiBase = '',
  downloadOrigin = '',
  embedded = false,
  renderHeader,
  notices = null,
  preview = null,
  onReady,
}: PageReaderProps) {
  // A refresh that came back with a payload (a host with no router) replaces
  // content AND section state in one update — the unlock settles on a new
  // `readerSections` identity — until the host hands over another payload or
  // another page.
  const [refreshed, setRefreshed] = useState<RefreshedPayload | null>(null);
  const current =
    refreshed && refreshed.base === payload && refreshed.pageId === page.id
      ? refreshed.payload
      : payload;
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const pageIdRef = useRef(page.id);
  pageIdRef.current = page.id;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const refresh = useCallback(async () => {
    const run = onRefreshRef.current ?? NO_REFRESH;
    const base = payloadRef.current;
    const pageId = pageIdRef.current;
    const next = await run();
    if (next && pageIdRef.current === pageId) setRefreshed({ base, pageId, payload: next });
  }, []);

  // This reader's ticks and unlocks. Here, not in the viewer, so a viewer
  // rebuild (asset retry) never drops an unlock in flight.
  const sections = useReaderSectionsState(page.id, current.readerSections, current.signInUrl, {
    refresh,
    notify,
    apiBase,
  });
  // Stored refs stay in the document; these are the URLs to display them with.
  const assets = useAssetMap(current.assets, page.id);
  // An expired signature on a stale tab re-resolves once instead of leaving a
  // page of broken images; the epoch rebuilds the viewer with the new map.
  // Only where the host can load the page again: with nothing to refresh
  // from (the MCP's page render) a failed image must not rebuild the viewer
  // under a measurement.
  const assetEpoch = useAssetRetry(refresh, Boolean(onRefresh));
  // Comments: only for a member who may read them (the key is absent otherwise).
  const comments = usePageCommentsController(page.id, current.readerComments, {
    apiBase,
    notify,
  });

  // BlockNote's theme follows the `dark` CLASS on <html> (the boot script's
  // and the host's, from the OS or a `?theme=`), the signal every `dark:`
  // utility around the reader keys on too.
  const [isClient, setIsClient] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  useEffect(() => {
    setIsClient(true);
    const root = document.documentElement;
    const sync = () => setDarkMode(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Once the document is on screen: go to the heading the address names (once
  // per page — a viewer rebuilt by an asset retry must not pull the reader
  // back), and tell the host.
  const [ready, setReady] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const scrolledFor = useRef<string | null>(null);
  const handleMounted = useCallback(() => {
    if (scrolledFor.current !== pageIdRef.current) {
      scrolledFor.current = pageIdRef.current;
      if (window.location.hash) hashTarget(window.location.hash)?.scrollIntoView();
    }
    setReady(true);
    onReadyRef.current?.();
  }, []);

  const surfaceValue = useMemo<ReaderSurfaceValue>(
    () => ({
      surface,
      links: current.links ?? {},
      scheduleHref: current.scheduleHref ?? null,
      downloadOrigin,
      apiBase,
      classroomSlug,
      navigatePage,
    }),
    [
      surface,
      current.links,
      current.scheduleHref,
      downloadOrigin,
      apiBase,
      classroomSlug,
      navigatePage,
    ]
  );

  const cover = current.coverImage;
  const coverUrl = cover?.url ? assets.displayUrl(cover.url) : null;
  const commentsButton = comments ? <CommentsButton controller={comments} /> : null;
  const floatingButton = comments && (embedded || !renderHeader);

  return (
    <ReaderSurfaceContext.Provider value={surfaceValue}>
      {renderHeader ? renderHeader(embedded ? null : commentsButton) : null}
      {floatingButton && comments && <CommentsButton controller={comments} floating />}
      {comments && <CommentsPanel controller={comments} embedded={embedded} />}
      {notices}

      <div
        className="page-reader"
        data-reader-surface={surface}
        {...(ready ? { 'data-reader-ready': 'true' } : {})}
      >
        {coverUrl && (
          <ReaderCover
            imageUrl={coverUrl}
            position={cover?.position ?? 50}
            highlighted={Boolean(preview?.coverChanged)}
          />
        )}

        <div
          className={`mx-auto px-4 sm:px-6 lg:px-8 pb-16 ${pageWidthClass(page.width)} ${coverUrl ? 'mt-12' : 'mt-16'}`}
        >
          <div>
            <h1 className="text-5xl font-bold text-gray-900 dark:text-white mb-6">
              {page.title || 'Untitled'}
            </h1>
          </div>

          {page.is_draft && (
            <span className="inline-block px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200 rounded-full mb-2">
              Draft
            </span>
          )}

          {/* The page's own open threads (page-level), above the document. */}
          {comments && (
            <PageDiscussion
              controller={comments}
              pageLevelOnLoad={current.readerComments?.pageLevel ?? 0}
            />
          )}

          <div className="mt-2">
            {!isClient ? (
              /* SSR placeholder — BlockNote requires browser APIs */
              <LoadingContent />
            ) : (
              <Suspense fallback={<LoadingContent />}>
                {preview?.css && <style>{preview.css}</style>}
                <div className={preview?.css ? 'preview-highlight' : undefined}>
                  <BlockNoteViewer
                    // The epoch rebuilds the viewer after a 403 retry — BlockNote
                    // asks for a file URL once per mount, so a refreshed map only
                    // reaches it through a remount. Safe here and only here: the
                    // viewer holds no unsaved state, the editor does.
                    key={`${page.id}:${assetEpoch}`}
                    content={current.content}
                    darkMode={darkMode}
                    resolveFileUrl={assets.resolveFileUrl}
                    srcSets={current.srcSets}
                    displayUrl={assets.displayUrl}
                    pageId={page.id}
                    mediaDownloads={current.mediaDownloads}
                    downloadOrigin={downloadOrigin}
                    readerSections={sections}
                    comments={comments?.bridge ?? null}
                    headingAnchors
                    // The MCP's page render shows every toggle's body.
                    togglesOpen={surface === 'render'}
                    onMounted={handleMounted}
                  />
                </div>
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </ReaderSurfaceContext.Provider>
  );
}

export default PageReader;
