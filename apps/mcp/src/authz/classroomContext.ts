/**
 * Viewer → classroom context resolution (plan §4.1).
 *
 * Resolves a composite `org/slug` classroom reference (locked decision 1),
 * loads the caller's membership via the same service the webapp's
 * assertClassroomAccess uses, and applies the pure gates from ./pure.ts:
 * role set, entry gate (UNPUBLISHED blocks non-owners; LOCKED does not
 * block entry), and — for writes — the mutation gate (non-owners mutate
 * only when ACTIVE).
 *
 * All DECISIONS are made by the pure functions in ./pure.ts; this module
 * only fetches their inputs. Internal ownership checks (S1) must compare
 * `classroomId` — never re-resolve by slug.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ClassroomStatus, Role } from '@prisma/client';
import { ToolError } from '../mcp/errors.ts';
import type { Viewer } from '../auth/resolveViewer.ts';
import { assertEntryAllowed, parseClassroomRef, requireRole } from './pure.ts';

type Classroom = NonNullable<Awaited<ReturnType<typeof ClassmojiService.classroom.findById>>>;
type Membership = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.classroomMembership.findByClassroomAndUser>>
>;

export interface ClassroomContext {
  /** Canonical id for all S1 ownership comparisons. */
  classroomId: string;
  /**
   * Classroom sanitized via getClassroomForUI (SAFE_SETTINGS_FIELDS whitelist;
   * API keys replaced with has_* booleans) — never expose raw settings.
   */
  classroom: ReturnType<typeof ClassmojiService.classroom.getClassroomForUI<Classroom>>;
  /** Raw status kept alongside because handlers need it for mutation gating. */
  status: ClassroomStatus;
  /** The membership that satisfied the tool's role requirement. */
  membership: Membership;
  /** The caller's HIGHEST-privilege role among those satisfying the gate. */
  role: Role;
  /**
   * Every role the caller holds that satisfies the surface's role gate,
   * highest-privilege first (ClassroomMembership is unique on
   * (classroom_id, user_id, role) — multi-role users are normal).
   */
  roles: Role[];
}

/** Privilege order for deterministic multi-role resolution (highest first). */
const ROLE_PRIORITY: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

/**
 * Resolve the caller's authorization context in the classroom addressed by
 * `classroomRef` (`org/slug`).
 *
 * @throws ToolError('invalid_params') malformed reference
 * @throws ToolError('not_found')      no such classroom
 * @throws ToolError('forbidden')      not a member / insufficient role / unpublished entry
 */
export async function resolveClassroomContext(
  viewer: Viewer,
  classroomRef: string,
  { allowedRoles = null }: { allowedRoles?: readonly Role[] | null } = {}
): Promise<ClassroomContext> {
  const { org, slug } = parseClassroomRef(classroomRef);

  // Classroom.slug is unique per git org only (@@unique([git_org_id, slug])),
  // so resolve through the org login. GitHub logins are case-insensitive.
  const matches = (await ClassmojiService.classroom.findAll({
    slug,
    git_organization: { login: { equals: org, mode: 'insensitive' } },
  })) as Classroom[];
  // Classroom is unique only on (git_org_id, slug). The case-insensitive
  // org-login match means case-variant twin orgs each owning this slug can
  // return >1 row, and taking matches[0] would silently resolve to the newest
  // twin. Refuse an ambiguous reference; a zero-match stays indistinguishable
  // from it, so a probe never leaks whether a classroom exists (S1).
  if (matches.length !== 1) {
    throw new ToolError('not_found', `Classroom '${org}/${slug}' not found`);
  }
  const classroom = matches[0];

  // Role-filtered membership lookup — the same idiom as assertClassroomAccess
  // (packages/auth/src/server.ts). A user can hold several roles in one
  // classroom (ClassroomMembership is unique on (classroom_id, user_id, role)),
  // and findByClassroomAndUser is an UNORDERED findFirst — a single filtered
  // lookup would hand back an arbitrary matching role. Resolve each allowed
  // role explicitly, in privilege order, so multi-role callers deterministically
  // get their HIGHEST matching role (an OWNER+ASSISTANT reading a role-tiered
  // resource is genuinely an OWNER) and role-conditional read payloads (e.g.
  // roster's OWNER-only fields) never under-resolve.
  const rolesFilter = allowedRoles && allowedRoles.length > 0 ? [...allowedRoles] : null;
  const candidateRoles = rolesFilter
    ? ROLE_PRIORITY.filter(role => rolesFilter.includes(role))
    : [...ROLE_PRIORITY];
  const found = await Promise.all(
    candidateRoles.map(role =>
      ClassmojiService.classroomMembership.findByClassroomAndUser(classroom.id, viewer.userId, [
        role,
      ])
    )
  );
  let memberships = found.filter((m): m is Membership => Boolean(m));
  if (memberships.length === 0 && rolesFilter) {
    // Distinguish "not a member" from "insufficient role" for the error message.
    const any = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.id,
      viewer.userId,
      null
    );
    memberships = any ? [any] : [];
  }

  // Pure decisions: role gate (memberships arrive highest-privilege first, so
  // the pick is deterministic), then entry gate.
  const effective = requireRole(memberships, allowedRoles);
  assertEntryAllowed({ status: classroom.status, role: effective.role });

  return {
    classroomId: classroom.id,
    classroom: ClassmojiService.classroom.getClassroomForUI(classroom),
    status: classroom.status,
    membership: effective,
    role: effective.role,
    roles: memberships.map(m => m.role),
  };
}
