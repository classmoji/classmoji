/**
 * deckViewContent.ts — which copy of a deck the viewer route renders.
 *
 * The deck viewer holds TWO copies of the same document and they are not
 * interchangeable:
 *
 *   - the LOADER's (`slideContent`), which has been through
 *     `resolveDeckAssets`, so its images are signed `content-*.classmoji.io`
 *     URLs. This is the one a reader should see.
 *   - the EDITOR's (`editableContent`), the stored document with raw
 *     `/content/...` refs. It has to stay unsigned: the editor posts its
 *     document back on save, and a signed URL that made that round trip would
 *     be committed into deck.json, freezing one viewer's expiring signature
 *     into the deck forever. It is also the next save's diff baseline.
 *
 * View mode used to prefer the editor's copy, and had to: the loader read the
 * Pages CDN, which lags a push by minutes, so after a save it was BEHIND. It no
 * longer is — the loader reads the deck text through the delivery Worker by
 * sha, and React Router revalidates it automatically off the back of the save
 * fetcher's action. So view mode goes back to the loader's copy as soon as that
 * refresh lands, and shows the legacy `/content/...` document only in the gap
 * before it does.
 *
 * Pure, and separated from the route so the choice can be pinned without a
 * browser or the dev stack.
 */

/** The two documents plus the two flags that choose between them. */
export interface DeckDisplayInputs {
  /** True while the live editor is mounted. */
  isEditing: boolean;
  /** A save's loader refresh has landed — see `settleSaveRefresh`. */
  viewFromLoader: boolean;
  /** The editor's copy: unsigned, and the next save's baseline. */
  editableContent: string | null;
  /** The loader's copy: signed through the delivery layer. */
  loaderContent: string | null;
}

/**
 * The document to render.
 *
 * Edit mode is absolute: the editor renders its OWN copy or nothing at all.
 * Substituting the loader's signed document there is the one thing this module
 * must never do — it would put signed URLs in front of the save round trip.
 */
export function displayDeckContent({
  isEditing,
  viewFromLoader,
  editableContent,
  loaderContent,
}: DeckDisplayInputs): string | null {
  if (isEditing) return editableContent;
  return viewFromLoader ? loaderContent || editableContent : editableContent || loaderContent;
}

/** What the viewer knows while it waits for a save's loader refresh. */
export interface SaveRefreshInputs {
  /** The loader's content as it stands now. */
  loaderContent: string | null;
  /** The loader's content at the moment the save's action returned. */
  preSaveContent: string | null;
  /** The save fetcher has finished — action AND its revalidation. */
  fetcherIdle: boolean;
}

/** Whether to keep waiting, and what view mode should render once we stop. */
export interface SaveRefreshOutcome {
  /** False while the refresh is still outstanding. */
  settled: boolean;
  /** True only when the loader actually came back with the committed deck. */
  viewFromLoader: boolean;
}

/**
 * Decide whether a save's loader refresh has landed.
 *
 * There is nothing to trigger — the revalidation is already in flight when the
 * action returns — only something to wait for, and the wait has to be told
 * apart from a loader that never came back with anything new. NEW loader
 * content is that signal, and it is checked before the fetcher's idle state on
 * purpose: the two can arrive in either order, and settling on "idle" first
 * would give up one render before the answer showed up.
 *
 * Everything else settles on the copy the client saved locally — the behaviour
 * that shipped before this — so a no-op save, or a route that later opts out of
 * revalidation, degrades to "no worse than before" rather than to stale slides.
 */
export function settleSaveRefresh({
  loaderContent,
  preSaveContent,
  fetcherIdle,
}: SaveRefreshInputs): SaveRefreshOutcome {
  if (loaderContent && loaderContent !== preSaveContent) {
    return { settled: true, viewFromLoader: true };
  }
  return { settled: fetcherIdle, viewFromLoader: false };
}
