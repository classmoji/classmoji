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
 * Shape of `req.auth` populated by `requireValidJwt` — re-declared here so
 * `resolveAuthContext` can take the whole object instead of seven positional
 * args. Kept loose (only the fields we read) so the validator can grow.
 */
export interface RequestAuth {
  clientId: string;
  scopes: string[];
  extra: {
    userId: string;
    tokenId: string;
    cmRoles?: string[];
  };
}

/**
 * Build the per-session AuthContext from validated JWT claims.
 *
 * Looks up the user's classroom memberships once per session — used for both
 * tool-list filtering and Zod enum validation of `classroomSlug` arguments.
 * The per-classroom role check still happens inside each tool handler via
 * `resolveClassroom()` (defense in depth).
 *
 * The `cm_roles` JWT claim ("view-as") restricts the session's effective
 * roles to a subset the user actually holds. Set by the dev mint endpoint;
 * absent in production tokens until/unless we add a customAccessTokenClaims
 * hook.
 */
export async function resolveAuthContext(auth: RequestAuth): Promise<AuthContext> {
  const { userId, tokenId, cmRoles } = auth.extra;
  const oauthClientId = auth.clientId === 'unknown' ? null : auth.clientId;

  const memberships = await getPrisma().classroomMembership.findMany({
    where: { user_id: userId, has_accepted_invite: true },
    include: { classroom: { select: { slug: true } } },
  });

  const allRoles = new Set(memberships.map(m => m.role));
  const effectiveRoles =
    cmRoles && cmRoles.length > 0
      ? new Set([...allRoles].filter(r => cmRoles.includes(r)))
      : allRoles;

  return {
    userId,
    accessTokenId: tokenId,
    oauthClientId,
    scopes: expandScopes(auth.scopes),
    roles: effectiveRoles,
    classroomSlugs: [...new Set(memberships.map(m => m.classroom.slug))],
    activeSlug: null,
  };
}
