import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { getRoleFromPath } from '~/constants/roleSettings';
import useStore from '~/store';

/** The panel, its controller and the chat stack: loaded on the first open only. */
const AskMojiFloating = lazy(() => import('./AskMojiFloating'));

/** What the root loader says about Ask Moji for the classroom in the URL. */
export interface AskMojiRootConfig {
  /** `askMojiAvailable` for this classroom, for a member of it. */
  available: boolean;
  courseName: string | null;
  pagesUrl: string | null;
  slidesUrl: string | null;
}

const CLASSROOM_PATH = /^\/(student|admin|teacher|assistant)\/([^/]+)/;

/**
 * The webapp's Ask Moji (the Trigger runtime): the floating panel the sidebar
 * button opens. Mounted once in the root, keyed on classroom + view (the URL's
 * role prefix), so moving to another classroom or view is a new panel, while
 * moving between pages of the same one keeps the conversation (and a reply
 * still streaming) as it is.
 *
 * Shown only when the root loader says Ask Moji is available here; hidden on
 * a route that asks for it (`useHideAskMoji`, a live quiz attempt), without
 * unmounting.
 *
 * Loading: the root lazy-loads this module only on the Trigger runtime where
 * Ask Moji is available, and this module lazy-loads the panel (the AI SDK,
 * the Trigger transport, the Markdown renderer) the first time it opens. The
 * sidebar button needs only the store flags set here.
 */
export default function AskMojiRoot({ config }: { config: AskMojiRootConfig }) {
  const { pathname } = useLocation();
  const match = pathname.match(CLASSROOM_PATH);
  const slug = match?.[2] ?? null;
  const viewAs = match ? (getRoleFromPath(match[1]) ?? null) : null;

  const isOpen = useStore(s => s.isAskMojiOpen);
  const setOpen = useStore(s => s.setAskMojiOpen);
  const setEnabled = useStore(s => s.setAskMojiEnabled);
  const setActive = useStore(s => s.setAskMojiActive);
  const hidden = useStore(s => s.askMojiHideCount > 0);
  const stored = useStore(s => s.askMojiViewing);

  const enabled = Boolean(slug && config.available);

  // Client only: the transport and the chat live in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setEnabled(enabled);
  }, [enabled, setEnabled]);
  // Unmounted (a classroom without Ask Moji): the button goes with it.
  useEffect(
    () => () => {
      setEnabled(false);
      setActive(false);
    },
    [setEnabled, setActive]
  );

  // Another classroom or view: the panel closes (a new one mounts for it).
  const place = `${slug ?? ''}:${viewAs ?? ''}`;
  const lastPlace = useRef(place);
  useEffect(() => {
    if (lastPlace.current !== place) {
      lastPlace.current = place;
      setOpen(false);
    }
  }, [place, setOpen]);

  useEffect(() => {
    if ((hidden || !enabled) && isOpen) setOpen(false);
  }, [hidden, enabled, isOpen, setOpen]);

  // The sidebar's dot: the panel is open.
  const shown = isOpen && enabled && !hidden;
  useEffect(() => {
    setActive(shown);
  }, [shown, setActive]);

  // The panel chunk loads on the first open and then stays: closing hides it.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (shown) setLoaded(true);
  }, [shown]);

  const viewing = useMemo(
    () =>
      stored
        ? {
            kind: stored.kind,
            ...(stored.id ? { id: stored.id } : {}),
            ...(typeof stored.slide === 'number' ? { slide: stored.slide } : {}),
            ...(stored.title ? { title: stored.title } : {}),
          }
        : null,
    [stored]
  );

  if (!mounted || !enabled || !slug || !(loaded || shown)) return null;

  return (
    <Suspense fallback={null}>
      <AskMojiFloating
        key={place}
        classroomSlug={slug}
        viewAs={viewAs}
        open={shown}
        onRequestClose={() => setOpen(false)}
        courseName={config.courseName ?? ''}
        pagesUrl={config.pagesUrl}
        slidesUrl={config.slidesUrl}
        viewing={viewing}
      />
    </Suspense>
  );
}
