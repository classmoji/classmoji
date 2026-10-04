/**
 * The server-side gates of live editing, as pure decisions the loader and the
 * action call and the unit suite drives directly (tests/unit/collab-mode.spec.ts).
 */

/**
 * What a writer that predates live editing is told when it posts to a page
 * that is now edited live (a tab opened before the classroom switched over).
 */
export const LIVE_PAGE_MESSAGE = 'This page is now edited live. Reload to keep editing.';

/**
 * Whether this page view joins the live room. Everything must hold: the
 * person edits pages here, the classroom edits live (env resolved), a user is
 * signed in, the page is not showing a preview branch, and the classroom lets
 * this role write (a LOCKED or UNPUBLISHED classroom is read-only for
 * non-owners — the collab server would refuse the room anyway, so the page
 * opens as it always has).
 */
export function joinsLiveRoom({
  canEdit,
  liveClassroom,
  signedIn,
  previewActive,
  mutationBlocked,
}: {
  canEdit: boolean;
  liveClassroom: boolean;
  signedIn: boolean;
  previewActive: boolean;
  mutationBlocked: boolean;
}): boolean {
  return canEdit && liveClassroom && signedIn && !previewActive && !mutationBlocked;
}

/** The intents that write content.json from this app. */
const GIT_WRITE_INTENTS = new Set(['save', 'set-header-image', 'upload-header-image']);

/**
 * The action's answer to an intent that would write content.json for a page
 * that is edited live, or null to carry on. A save gets `conflict` with no
 * report (the git editor's "reload" banner) and no `code`, which would start
 * the editor's whole-document fallback against this same refusal.
 */
export function liveIntentRefusal(
  intent: unknown,
  liveClassroom: boolean
): { status: number; body: Record<string, unknown> } | null {
  if (!liveClassroom || typeof intent !== 'string' || !GIT_WRITE_INTENTS.has(intent)) return null;
  if (intent === 'save') {
    return { status: 409, body: { conflict: true, message: LIVE_PAGE_MESSAGE } };
  }
  return { status: 409, body: { error: LIVE_PAGE_MESSAGE } };
}

/**
 * Whether a pending preview is reviewed as the rendered page with its changes
 * marked (and never as a diff): classrooms with live editing switched on. The
 * one predicate for both the highlight and dropping the diff link, so the two
 * never disagree.
 */
export function previewReviewedAsPage(classroom: unknown): boolean {
  return Boolean(
    classroom &&
    typeof classroom === 'object' &&
    (classroom as { collab_enabled?: unknown }).collab_enabled === true
  );
}
