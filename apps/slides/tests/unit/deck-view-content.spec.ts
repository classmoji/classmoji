/**
 * Unit tests for `deckViewContent` — which copy of a deck the viewer renders,
 * and when a save's loader refresh counts as landed.
 *
 * The regression: after a save, view mode kept rendering the EDITOR's copy —
 * the stored document, with raw `/content/...` image refs — until a full page
 * reload. That preference was correct once, because the loader read the Pages
 * CDN and was minutes behind a push. It is not any more: the loader reads the
 * deck text through the delivery Worker by sha, and React Router revalidates it
 * automatically off the back of the save fetcher's action.
 *
 * Runs in the Playwright runner WITHOUT a browser — both functions are pure.
 */

import { test, expect } from '@playwright/test';
import { displayDeckContent, settleSaveRefresh } from '../../app/utils/deckViewContent.ts';

/** The loader's copy: images resolved to signed delivery URLs. */
const SIGNED = '<section><img src="https://content-staging.classmoji.io/c/abc/blob/sha1"></section>';
/** The editor's copy of the SAME deck: stored refs, and it must stay that way. */
const STORED = '<section><img src="/content/cs98-org/cs98-content/slides/w1/hero.jpeg"></section>';

test.describe('displayDeckContent — which document is on screen', () => {
  test('edit mode renders the editor copy, and only ever that', () => {
    // Handing the editor the signed document is the one thing this must never
    // do: the editor posts its document back on save, so a signed URL that made
    // that round trip would be committed into deck.json.
    expect(
      displayDeckContent({
        isEditing: true,
        viewFromLoader: false,
        editableContent: STORED,
        loaderContent: SIGNED,
      })
    ).toBe(STORED);
    // Even once view mode has switched over to the loader.
    expect(
      displayDeckContent({
        isEditing: true,
        viewFromLoader: true,
        editableContent: STORED,
        loaderContent: SIGNED,
      })
    ).toBe(STORED);
    // And with nothing to edit yet, the editor gets nothing — not the loader's.
    expect(
      displayDeckContent({
        isEditing: true,
        viewFromLoader: true,
        editableContent: null,
        loaderContent: SIGNED,
      })
    ).toBe(null);
  });

  test('a page that has saved nothing is unchanged', () => {
    // First render: no editor copy exists, so the loader's is what shows.
    expect(
      displayDeckContent({
        isEditing: false,
        viewFromLoader: false,
        editableContent: null,
        loaderContent: SIGNED,
      })
    ).toBe(SIGNED);
  });

  test('view mode switches to the loader copy once the refresh has landed', () => {
    const inputs = { isEditing: false, editableContent: STORED, loaderContent: SIGNED };
    // Before: the save has returned but its revalidation has not, so `SIGNED`
    // is still the PRE-save deck. Showing it would flash the old slides.
    expect(displayDeckContent({ ...inputs, viewFromLoader: false })).toBe(STORED);
    // After: the loader has the committed deck, signed. This is the fix — it
    // used to stay on STORED until a full page reload.
    expect(displayDeckContent({ ...inputs, viewFromLoader: true })).toBe(SIGNED);
  });

  test('a missing loader document always falls back to the editor copy', () => {
    // `contentError` in the loader → nothing to render from it. Never blank the
    // deck when we are holding a perfectly good copy of it.
    expect(
      displayDeckContent({
        isEditing: false,
        viewFromLoader: true,
        editableContent: STORED,
        loaderContent: null,
      })
    ).toBe(STORED);
  });
});

test.describe('settleSaveRefresh — has the save’s loader refresh landed', () => {
  test('new loader content settles it, whatever the fetcher is doing', () => {
    // Checked BEFORE the idle state on purpose: the two can arrive in either
    // order, and settling on idle first would give up one render too early.
    expect(
      settleSaveRefresh({ loaderContent: SIGNED, preSaveContent: 'old', fetcherIdle: false })
    ).toEqual({ settled: true, viewFromLoader: true });
    expect(
      settleSaveRefresh({ loaderContent: SIGNED, preSaveContent: 'old', fetcherIdle: true })
    ).toEqual({ settled: true, viewFromLoader: true });
  });

  test('an in-flight refresh keeps waiting', () => {
    expect(
      settleSaveRefresh({ loaderContent: 'old', preSaveContent: 'old', fetcherIdle: false })
    ).toEqual({ settled: false, viewFromLoader: false });
  });

  test('a loader that never came back with anything new keeps the saved copy', () => {
    // A no-op save, or a route that later opts out of revalidation: stop
    // waiting, but stay on what the client saved locally — the behaviour that
    // shipped before this. Degrading to stale slides would be worse.
    expect(
      settleSaveRefresh({ loaderContent: 'old', preSaveContent: 'old', fetcherIdle: true })
    ).toEqual({ settled: true, viewFromLoader: false });
    // Same for a loader with no content at all.
    expect(
      settleSaveRefresh({ loaderContent: null, preSaveContent: null, fetcherIdle: true })
    ).toEqual({ settled: true, viewFromLoader: false });
  });
});
