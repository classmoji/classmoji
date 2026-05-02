import getPrisma from '@classmoji/database';
import type { Classroom, ClassroomMembership, GitOrganization, Role } from '@prisma/client';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import type { AuthContext } from '../auth/context.ts';

interface ClassroomResolution {
  classroom: Classroom & { git_organization?: GitOrganization | null };
  memberships: ClassroomMembership[];
  roles: Set<Role>;
}

/**
 * Per-tool-call: resolve a classroom context from a slug, verifying that
 * the calling user is a member. Falls back to the session-level
 * `activeSlug` when `slug` is omitted.
 *
 * Caches results per (userId, slug) for 60s within a session to absorb
 * repeated calls during agentic loops. Trade-off: an admin removing a user
 * mid-session has up to 60s of stale-cache exposure (documented in plan
 * Security #20).
 */
const sessionCache = new Map<
  string,
  { result: ClassroomResolution; expiresAt: number }
>();

const CACHE_TTL_MS = 60_000;

export async function resolveClassroom(
  ctx: AuthContext,
  slug: string | undefined
): Promise<ClassroomResolution> {
  const targetSlug = slug ?? ctx.activeSlug;
  if (!targetSlug) {
    throw mcpError(
      'classroomSlug is required (or call set_active_classroom first)',
      ErrorCode.InvalidParams
    );
  }

  const cacheKey = `${ctx.userId}:${targetSlug}`;
  const now = Date.now();
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.result;

  const prisma = getPrisma();
  const classroom = await prisma.classroom.findUnique({
    where: { slug: targetSlug },
    include: { git_organization: true },
  });
  if (!classroom) {
    throw mcpError(`Classroom not found: ${targetSlug}`, ErrorCode.InvalidParams);
  }

  const memberships = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroom.id, user_id: ctx.userId },
  });
  if (memberships.length === 0) {
    throw mcpError('Not a member of this classroom', ErrorCode.InvalidRequest);
  }

  const result: ClassroomResolution = {
    classroom,
    memberships,
    roles: new Set(memberships.map(m => m.role)),
  };

  sessionCache.set(cacheKey, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

export function clearClassroomCache(): void {
  sessionCache.clear();
}
