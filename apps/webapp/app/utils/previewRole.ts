/**
 * "Preview as" — letting a classroom OWNER see the app the way their teaching
 * team and students see it.
 *
 * ─── SECURITY ───────────────────────────────────────────────────────────────
 * This is a CLIENT-SIDE DISPLAY RELABEL OF THE OWNER'S OWN ACCESS. It grants
 * nothing, and it cannot.
 *
 * The mechanism already existed in root.tsx's role-resolution effect: when the
 * URL prefix names a role the viewer does not hold, but they DO hold OWNER in
 * that same classroom, the effect keeps their real OWNER membership and only
 * relabels the DISPLAYED role to the URL's role. That branch is reached solely
 * by finding an `m.role === 'OWNER'` membership for that classroom, so a
 * non-owner never enters it — the store is simply never set for them, and the
 * layout's RequireRole renders nothing.
 *
 * Nothing here changes that. These functions only READ the memberships the root
 * loader already sent and answer "should the owner be shown a preview control,
 * and are they in a preview right now". There is no setter, no store write and
 * no way for a caller to assert a display role it has not proved: every entry
 * point requires a real OWNER membership in THAT classroom, matched by slug.
 *
 * The SERVER is unaffected in every case. Loaders and actions resolve the
 * caller through `resolveHighestMembership` (packages/auth), which reads the
 * database, not the URL — so an owner previewing as a student is still resolved
 * as OWNER and every gate still evaluates their real role. The URL prefix is
 * not an authorization input anywhere.
 *
 * Consequently this is NOT better-auth impersonation, which is a different
 * thing and deliberately not used here: impersonation SWAPS IDENTITY (the
 * session becomes another user) and is gated on the GLOBAL `User.role ===
 * 'admin'` flag rather than on any classroom role. "Let me see what my TAs see"
 * needs neither of those.
 */

import { getRoleFromPath, roleSettings } from '~/constants/roleSettings';

/** Roles an owner may preview, most privileged first. */
export const PREVIEWABLE_ROLES = ['TEACHER', 'ASSISTANT', 'STUDENT'] as const;

export type PreviewableRole = (typeof PREVIEWABLE_ROLES)[number];

/** The prefix an owner's own, unprevewed view lives under. */
export const OWNER_PREFIX = 'admin';

/**
 * Landing section for a preview switch or exit.
 *
 * Deliberately not "the same page under the other prefix": the prefixes do not
 * serve the same set of sections (there is no /teacher/:class/assistants, for
 * instance), so carrying the current section across would land an owner on a
 * 404 exactly when they are trying to orient themselves. The dashboard exists
 * under all four prefixes, and it is already where the assistants page's
 * "View as" control sends an impersonator.
 */
const LANDING_SECTION = 'dashboard';

interface MembershipLike {
  role?: string | null;
  organization?: { login?: string | null } | null;
}

/**
 * Does this viewer hold a real OWNER membership in THIS classroom?
 *
 * The whole feature hangs off this predicate, so it is deliberately strict:
 * the membership list is the one the root loader sent for the SIGNED-IN user,
 * the classroom is matched by slug, and the role must be exactly OWNER. Holding
 * OWNER in some other classroom is not enough.
 */
export const holdsOwnerMembership = (
  memberships: MembershipLike[] | undefined | null,
  classroomSlug: string | undefined | null
): boolean => {
  if (!classroomSlug) return false;
  return (memberships ?? []).some(
    membership => membership?.role === 'OWNER' && membership?.organization?.login === classroomSlug
  );
};

export interface PreviewState {
  /** Show the owner the preview control at all. */
  canPreview: boolean;
  /** The role currently being previewed, or null when in the owner's own view. */
  previewRole: PreviewableRole | null;
  /** Convenience: the owner is looking at someone else's view of the class. */
  isPreviewing: boolean;
}

const NOT_PREVIEWING: PreviewState = {
  canPreview: false,
  previewRole: null,
  isPreviewing: false,
};

/**
 * Resolve whether to offer a preview control, and whether one is active.
 *
 * A NON-OWNER always gets `{ canPreview: false, isPreviewing: false }`, whatever
 * prefix they are on — a teacher browsing /teacher is simply in their own view,
 * and a teacher who hand-types /student is not "previewing", they are a
 * non-owner on a prefix whose store role never gets set.
 */
export const resolvePreviewState = ({
  memberships,
  classroomSlug,
  rolePrefix,
}: {
  memberships: MembershipLike[] | undefined | null;
  classroomSlug: string | undefined | null;
  rolePrefix: string | undefined | null;
}): PreviewState => {
  if (!holdsOwnerMembership(memberships, classroomSlug)) return NOT_PREVIEWING;

  // The owner's own prefix is not a preview.
  if (!rolePrefix || rolePrefix === OWNER_PREFIX) {
    return { canPreview: true, previewRole: null, isPreviewing: false };
  }

  // Only a prefix that names a previewable role counts. An unrelated prefix
  // (/oauth, /api, anything new) leaves the owner in their normal view rather
  // than claiming they are previewing something.
  const role = getRoleFromPath(rolePrefix);
  const previewRole = PREVIEWABLE_ROLES.find(candidate => candidate === role) ?? null;

  return {
    canPreview: true,
    previewRole,
    isPreviewing: previewRole !== null,
  };
};

/** Path an owner lands on when entering a preview as `role`. */
export const previewPathFor = (role: PreviewableRole, classroomSlug: string): string =>
  `${roleSettings[role].path}/${classroomSlug}/${LANDING_SECTION}`;

/** Path back to the owner's own view. */
export const ownerExitPath = (classroomSlug: string): string =>
  `${roleSettings.OWNER.path}/${classroomSlug}/${LANDING_SECTION}`;

/** Title-cased role name for display ("TEACHER" -> "Teacher"). */
export const previewRoleLabel = (role: PreviewableRole): string =>
  role.charAt(0) + role.slice(1).toLowerCase();
