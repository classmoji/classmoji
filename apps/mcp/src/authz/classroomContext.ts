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
  role: Role;
}

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
  const classroom = matches[0];
  if (!classroom) {
    throw new ToolError('not_found', `Classroom '${org}/${slug}' not found`);
  }

  // Role-filtered membership lookup — the same idiom as assertClassroomAccess
  // (packages/auth/src/server.ts:582-592). A user can hold several roles in
  // one classroom, so querying WITH the allowed-role filter is what finds the
  // satisfying membership for multi-role users.
  const rolesFilter = allowedRoles && allowedRoles.length > 0 ? [...allowedRoles] : null;
  let membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    viewer.userId,
    rolesFilter
  );
  if (!membership && rolesFilter) {
    // Distinguish "not a member" from "insufficient role" for the error message.
    membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.id,
      viewer.userId,
      null
    );
  }

  // Pure decisions: role gate, then entry gate.
  const effective = requireRole(membership ? [membership] : [], allowedRoles);
  assertEntryAllowed({ status: classroom.status, role: effective.role });

  return {
    classroomId: classroom.id,
    classroom: ClassmojiService.classroom.getClassroomForUI(classroom),
    status: classroom.status,
    membership: effective,
    role: effective.role,
  };
}
