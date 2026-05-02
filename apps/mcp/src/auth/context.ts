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
 */
export async function resolveAuthContext(
  userId: string,
  tokenId: string,
  oauthClientId: string | null,
  scopeString: string
): Promise<AuthContext> {
  const memberships = await getPrisma().classroomMembership.findMany({
    where: { user_id: userId, has_accepted_invite: true },
    include: { classroom: { select: { slug: true } } },
  });

  return {
    userId,
    accessTokenId: tokenId,
    oauthClientId,
    scopes: expandScopes(scopeString),
    roles: new Set(memberships.map(m => m.role)),
    classroomSlugs: [...new Set(memberships.map(m => m.classroom.slug))],
    activeSlug: null,
  };
}
