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
 * Pages CDN, which lags a push by minutes, so after a save it was BEHIND.
 * Usually it no longer is — WHEN the classroom's delivery flag is on, the
 * signing env is configured and the asset map has a row for the path, the
 * loader reads the deck text through the Worker by sha; otherwise it still
 * falls back to the contents API and then that same lagging CDN. React Router
 * revalidates the loader automatically off the back of the save fetcher's
 * action either way. So view mode goes back to the loader's copy once that
 * refresh is CONFIRMED — by sha, see `settleSaveRefresh`, because on the
 * fallback paths it may well not be fresh — and otherwise stays on the
 * document the client saved.
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
  /**
   * The git blob sha of the index.html the loader's view-mode read resolved,
   * or null when that read could not name an object (the CDN fallback, or an
   * edit/preview-branch render generated from deck.json).
   */
  loaderSha: string | null;
  /** The git blob sha of the index.html the save just committed. */
  savedSha: string | null;
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
 * apart from a loader that came back with a STALE deck.
 *
 * The test is IDENTITY, not bytes. Comparing rendered HTML cannot work here:
 * the read side signs asset URLs per viewer, and the `draft` tier anyone with
 * edit access gets is an exact `now + 4h` rather than a bucketed expiry, so two
 * reads of an unchanged deck differ every second. "The document changed" would
 * be true on every single read, and a stale one — a map row not yet updated, a
 * Worker 502 falling back to another instance's <60s API cache — would settle
 * as if it were fresh and put the PRE-save deck on screen. Worse than the bug
 * this set out to fix.
 *
 * So: the loader must name the very object the save committed. A different sha
 * is a read that has not caught up; a null sha is a read that cannot say what
 * it fetched. Both settle on the copy the client saved locally — the behaviour
 * that shipped before this — so every uncertain case degrades to "no worse than
 * before" rather than to stale slides.
 */
export function settleSaveRefresh({
  loaderSha,
  savedSha,
  fetcherIdle,
}: SaveRefreshInputs): SaveRefreshOutcome {
  if (savedSha && loaderSha === savedSha) {
    return { settled: true, viewFromLoader: true };
  }
  return { settled: fetcherIdle, viewFromLoader: false };
}
