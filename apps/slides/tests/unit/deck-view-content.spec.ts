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
  const SAVED = 'a'.repeat(40);
  const OLDER = 'b'.repeat(40);

  test('the loader naming the committed deck settles it, fetcher or no fetcher', () => {
    // Checked BEFORE the idle state on purpose: the loader data and the
    // fetcher's idle transition can arrive in either order, and settling on
    // idle first would give up one render before the answer showed up.
    expect(settleSaveRefresh({ loaderSha: SAVED, savedSha: SAVED, fetcherIdle: false })).toEqual({
      settled: true,
      viewFromLoader: true,
    });
    expect(settleSaveRefresh({ loaderSha: SAVED, savedSha: SAVED, fetcherIdle: true })).toEqual({
      settled: true,
      viewFromLoader: true,
    });
  });

  test('an in-flight refresh keeps waiting', () => {
    expect(settleSaveRefresh({ loaderSha: OLDER, savedSha: SAVED, fetcherIdle: false })).toEqual({
      settled: false,
      viewFromLoader: false,
    });
  });

  test('a loader read that has not caught up never wins', () => {
    // The map row is not updated yet, or a Worker 502 fell back to another
    // instance's <60s API cache. The bytes WILL differ from the last read —
    // `draft` expiries are an exact now+4h, so every signed URL in the document
    // changes every second — which is exactly why identity is the test and
    // "the document changed" is not. Settling true here would put the PRE-save
    // deck on screen: worse than the bug this fixes.
    expect(settleSaveRefresh({ loaderSha: OLDER, savedSha: SAVED, fetcherIdle: true })).toEqual({
      settled: true,
      viewFromLoader: false,
    });
  });

  test('a read that cannot name what it fetched never wins', () => {
    // The CDN fallback serves a path and reports no object id, and so does an
    // edit/preview-branch render generated from deck.json. Null is "cannot
    // tell", and must never be read as agreement — including with itself.
    expect(settleSaveRefresh({ loaderSha: null, savedSha: SAVED, fetcherIdle: false })).toEqual({
      settled: false,
      viewFromLoader: false,
    });
    expect(settleSaveRefresh({ loaderSha: null, savedSha: SAVED, fetcherIdle: true })).toEqual({
      settled: true,
      viewFromLoader: false,
    });
    expect(settleSaveRefresh({ loaderSha: null, savedSha: null, fetcherIdle: true })).toEqual({
      settled: true,
      viewFromLoader: false,
    });
  });

  test('a save that reported no sha keeps the locally saved copy', () => {
    // Nothing to match against — an older server, or a path that did not
    // return one. Degrade to the behaviour that shipped before this.
    expect(settleSaveRefresh({ loaderSha: SAVED, savedSha: null, fetcherIdle: true })).toEqual({
      settled: true,
      viewFromLoader: false,
    });
  });
});
