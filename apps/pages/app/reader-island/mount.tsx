/**
 * The reader island: the shared page reader (`PageReader`) mounted with
 * `createRoot` into a server-rendered document that React Router does not
 * hydrate (the MCP's page render and the class site). Its data comes
 * from the inline `<script type="application/json">` the server wrote
 * (`ReaderIsland.tsx`); nothing here touches a router.
 *
 * Inside the island root, because a server-rendered container in a
 * non-hydrated document is inert: the toast container (the reader reports
 * failures with toasts) and a Mantine provider. Dark mode follows `html.dark`
 * (the document's boot script sets it; `PageReader` observes it).
 *
 * The document is marked ready (`data-render-ready`) once the reader is on
 * screen and settled (`readiness.ts`), or failed (`data-render-error`, with a
 * message in place of the reader) when anything throws — never left on its
 * loading line.
 */
import { Component, StrictMode, useCallback, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastContainer } from 'react-toastify';
import { MantineProvider } from '@mantine/core';

import { PageReader } from '~/components/reader/PageReader.tsx';
import {
  READER_ISLAND_DATA_ID,
  READER_ISLAND_ROOT_ID,
  parseIslandData,
  type ReaderIslandData,
} from './contract.ts';
import { markIslandReady, showIslandError } from './islandDom.ts';
import { readerSettled } from './readiness.ts';
import { hostOptionsFor, type ReaderIslandHost } from './hostOptions.ts';
import { keepScrollPosition } from './scrollMemory.ts';

export { hostOptionsFor, type ReaderIslandHost };

const noToastHotKey = () => false;

const MANTINE_THEME = {
  fontFamily:
    "'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  fontFamilyMonospace:
    "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
};

/** A reader that throws while rendering ends in the island's failure state. */
class IslandBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    showIslandError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ReaderIslandApp({
  data,
  host,
  onSettled,
}: {
  data: ReaderIslandData;
  host: ReaderIslandHost;
  /** Run once the reader is on screen and settled (the site's scroll restore). */
  onSettled?: () => void;
}) {
  // Once per document: a later remount of the viewer is not a new arrival.
  const settling = useRef(false);
  const content = data.payload.content;
  const onReady = useCallback(() => {
    if (settling.current) return;
    settling.current = true;
    const root = document.getElementById(READER_ISLAND_ROOT_ID) ?? document;
    // The reader is on screen: a failure while WAITING (not drawing) still
    // ends in ready, never in the error state.
    void readerSettled(root, content).then(
      how => {
        onSettled?.();
        markIslandReady(how);
      },
      error => {
        console.warn('[reader-island] readiness check failed', error);
        markIslandReady('unsettled');
      }
    );
  }, [content, onSettled]);

  return (
    <MantineProvider theme={MANTINE_THEME}>
      <ToastContainer
        position="top-center"
        autoClose={3000}
        hideProgressBar
        newestOnTop={false}
        closeOnClick
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="colored"
        hotKeys={noToastHotKey}
        aria-label="Notifications"
      />
      <PageReader
        payload={data.payload}
        page={data.page}
        surface={data.surface}
        classroomSlug={data.classroomSlug ?? null}
        apiBase={data.apiBase ?? ''}
        downloadOrigin={data.downloadOrigin ?? ''}
        {...(host.onRefresh ? { onRefresh: host.onRefresh } : {})}
        onReady={onReady}
        // The class site draws the cover and title in its own chrome.
        bodyOnly={data.surface === 'site'}
      />
    </MantineProvider>
  );
}

/**
 * Read the island's data and mount the reader into its root. `host`
 * overrides the surface's own options (`hostOptionsFor`); tests pass it.
 */
export function mountReaderIsland(host?: ReaderIslandHost): void {
  const rootElement = document.getElementById(READER_ISLAND_ROOT_ID);
  const data = parseIslandData(document.getElementById(READER_ISLAND_DATA_ID)?.textContent);
  if (!rootElement || !data) {
    showIslandError(new Error('The reader island has no root or no data.'));
    return;
  }
  // The class site keeps the visitor's place on reload and Back.
  const restoreScroll = data.surface === 'site' ? keepScrollPosition(window) : undefined;
  // The server's loading line goes when React takes the root over.
  createRoot(rootElement, {
    onUncaughtError: error => showIslandError(error),
  }).render(
    <StrictMode>
      <IslandBoundary>
        <ReaderIslandApp
          data={data}
          host={host ?? hostOptionsFor(data)}
          onSettled={restoreScroll}
        />
      </IslandBoundary>
    </StrictMode>
  );
}
