import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';
import { expandScopes } from './scopes.ts';

export interface AuthContext {
  userId: string;
  /** SHA-256 of the raw bearer token (16 hex chars) — for audit traceability. */
  accessTokenId: string;
  /** OAuth client_id from JWT `azp` claim — claude.ai / Claude Desktop / Claude Code. */
  oauthClientId: string | null;
  /** Expanded scopes (composites resolved). */
  scopes: Set<string>;
  /** Union of all roles the user holds across all classroom memberships. */
  roles: Set<Role>;
  /** Slugs of classrooms the user is a member of (for Zod enum validation). */
  classroomSlugs: string[];
  /**
   * Session-mutable. Starts null; set by `set_active_classroom` tool. When
   * a tool omits `classroomSlug`, this is the fallback.
   */
  activeSlug: string | null;
}

/**
 * Build the per-session AuthContext from validated JWT claims.
 *
 * Looks up the user's classroom memberships once per session — used for both
 * tool-list filtering and Zod enum validation of `classroomSlug` arguments.
 * The per-classroom role check still happens inside each tool handler via
 * `resolveClassroom()` (defense in depth).
 *
 * If `viewAsRoles` is provided (from a `cm_roles` JWT claim — set by the
 * dev mint endpoint or by a future BetterAuth customAccessTokenClaims hook),
 * restrict the session's effective roles to the listed subset. Lets one
 * user with multiple roles in a classroom test the experience of a more
 * restricted role without changing memberships.
 */
export async function resolveAuthContext(
  userId: string,
  tokenId: string,
  oauthClientId: string | null,
  scopeString: string,
  viewAsRoles?: string[]
): Promise<AuthContext> {
  const memberships = await getPrisma().classroomMembership.findMany({
    where: { user_id: userId, has_accepted_invite: true },
    include: { classroom: { select: { slug: true } } },
  });

  const allRoles = new Set(memberships.map(m => m.role));
  // Filter to the requested subset, but only roles the user actually holds.
  // (You can't view-as a role you don't have.)
  const effectiveRoles =
    viewAsRoles && viewAsRoles.length > 0
      ? new Set([...allRoles].filter(r => viewAsRoles.includes(r)))
      : allRoles;

  return {
    userId,
    accessTokenId: tokenId,
    oauthClientId,
    scopes: expandScopes(scopeString),
    roles: effectiveRoles,
    classroomSlugs: [...new Set(memberships.map(m => m.classroom.slug))],
    activeSlug: null,
  };
}
