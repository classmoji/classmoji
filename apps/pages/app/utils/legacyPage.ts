/**
 * Legacy pages: a content folder with `index.html` and no `content.json`.
 *
 * The pages app no longer converts them on read (the old conversion ran
 * BlockNote's server editor, jsdom, on every view). They are converted in
 * place by the operator script `packages/tasks/src/scripts/
 * convertLegacyPages.ts`. A page still in the old format is shown to readers
 * as an empty document; its staff are told why.
 *
 * The live editor is not affected: collab still seeds a legacy page's room
 * from `index.html` when an owner or teacher opens it there, and the first
 * checkpoint after an edit writes `content.json`. So such a page is legacy
 * IN GIT (what readers get) while the live room holds its converted blocks.
 *
 * Nothing outside the live editor writes `content.json` for such a page: a
 * git-editor save or a cover change on it is refused (writing the empty
 * document would hide the page's content for good).
 */

/** Staff not in the live editor: the page is shown empty. */
export const LEGACY_PAGE_NOTICE = "This page is in an old format and can't be shown.";

/** An owner or teacher in the live editor: they see the page; readers do not. */
export const LEGACY_PAGE_LIVE_NOTICE =
  'This page is in an old format. Readers see it empty until it is edited.';

/** The answer to a write (save, cover) that would create content.json for such a page. */
export const LEGACY_PAGE_WRITE_REFUSAL =
  "This page is in an old format and can't be changed here. The Classmoji team can convert it.";

export type LegacyNotice = 'unshown' | 'live';

export function legacyNoticeText(kind: LegacyNotice): string {
  return kind === 'live' ? LEGACY_PAGE_LIVE_NOTICE : LEGACY_PAGE_NOTICE;
}

/** The document a reader is shown for a legacy page: one empty paragraph, as for a page with no file. */
export function emptyPageDocument(): Array<{ type: 'paragraph'; content: [] }> {
  return [{ type: 'paragraph', content: [] }];
}

/**
 * Which notice this viewer gets, if any. Only the page's staff (its editors
 * and teaching team) are told, and only when git holds the page as legacy
 * HTML: the live editor's copy when they are working in the live room, the
 * "can't be shown" copy otherwise. Students and anonymous visitors: none.
 */
export function legacyNoticeFor({
  legacyInGit,
  staff,
  liveEditor,
}: {
  legacyInGit: boolean;
  staff: boolean;
  /** This viewer joins the page's live room (the loader's `collab` is set). */
  liveEditor: boolean;
}): LegacyNotice | null {
  if (!legacyInGit || !staff) return null;
  return liveEditor ? 'live' : 'unshown';
}

/** A refused write on a legacy page (`savePageCoverImage`); the route answers `status`. */
export class LegacyPageFormatError extends Error {
  readonly status = 422;
  constructor() {
    super(LEGACY_PAGE_WRITE_REFUSAL);
    this.name = 'LegacyPageFormatError';
  }
}
