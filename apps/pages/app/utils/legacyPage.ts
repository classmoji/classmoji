/**
 * Legacy pages: a content folder with `index.html` and no `content.json`.
 *
 * Nothing converts them at request time: not the pages app (the old
 * conversion ran BlockNote's server editor, jsdom, on every view) and not the
 * collab server, which refuses a legacy page's live room (`legacy-html`). They
 * are converted in place by the operator script `packages/tasks/src/scripts/
 * convertLegacyPages.ts`. A page still in the old format is shown to readers
 * as an empty document; its staff are told why.
 *
 * Nothing writes `content.json` for such a page: there is no editor for it,
 * live or git, and a git-editor save or a cover change on it is refused
 * (writing the empty document would hide the page's content for good).
 */

/** Staff on a page in the old format: the page is shown empty, and cannot be edited. */
export const LEGACY_PAGE_NOTICE = "This page is in an old format and can't be shown.";

/** The answer to a write (save, cover) that would create content.json for such a page. */
export const LEGACY_PAGE_WRITE_REFUSAL =
  "This page is in an old format and can't be changed here. The Classmoji team can convert it.";

/** The document a reader is shown for a legacy page: one empty paragraph, as for a page with no file. */
export function emptyPageDocument(): Array<{ type: 'paragraph'; content: [] }> {
  return [{ type: 'paragraph', content: [] }];
}

/**
 * The one rule for a page git holds as legacy HTML, for every viewer of the
 * in-app page (live-editing classroom or not):
 * - `notice`: only the page's staff (its editors and teaching team) are told
 *   it "can't be shown"; students and anonymous visitors see the empty page.
 * - `readOnly`: nobody who could edit gets an editor. Not the live editor
 *   (collab refuses the room) and not the git editor (it would only offer to
 *   save the empty document over the page). The reader is shown instead.
 */
export function legacyPageRule({
  legacyInGit,
  staff,
  canEdit,
}: {
  legacyInGit: boolean;
  staff: boolean;
  canEdit: boolean;
}): { notice: boolean; readOnly: boolean } {
  return { notice: legacyInGit && staff, readOnly: legacyInGit && canEdit };
}

/** A refused write on a legacy page (`savePageCoverImage`); the route answers `status`. */
export class LegacyPageFormatError extends Error {
  readonly status = 422;
  constructor() {
    super(LEGACY_PAGE_WRITE_REFUSAL);
    this.name = 'LegacyPageFormatError';
  }
}
