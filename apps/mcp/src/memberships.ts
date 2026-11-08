/**
 * The caller's classroom memberships for the identity surface (`whoami`, the
 * `me` resource and its `my_classrooms` mirror): ONE entry per classroom,
 * with every role held there in `roles`, highest first (#846). The service
 * returns a row per membership, and a user may hold several roles in one
 * classroom (an owner who also tests as a student), which read as duplicate
 * classrooms. `role` stays as the highest of them for readers of the old
 * shape.
 */

import type { Role } from '@prisma/client';

export interface MembershipSummary {
  classroom: string;
  name: string;
  /** The highest role held here (OWNER > TEACHER > ASSISTANT > STUDENT). */
  role: Role;
  /** Every role held here, highest first. */
  roles: Role[];
  status: string;
  is_archived: boolean;
}

const ROLE_ORDER: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
const rank = (role: Role) => {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
};

interface MembershipRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_archived: boolean;
  git_organization?: { login: string | null } | null;
  membership: { role: Role };
}

/** Group membership rows by classroom, keeping the first-seen classroom order. */
export function summarizeMemberships(rows: readonly MembershipRow[]): MembershipSummary[] {
  const byClassroom = new Map<string, MembershipSummary>();
  for (const row of rows) {
    const existing = byClassroom.get(row.id);
    if (existing) {
      if (!existing.roles.includes(row.membership.role)) existing.roles.push(row.membership.role);
      continue;
    }
    byClassroom.set(row.id, {
      classroom: `${row.git_organization?.login ?? 'unknown'}/${row.slug}`,
      name: row.name,
      role: row.membership.role,
      roles: [row.membership.role],
      status: row.status,
      is_archived: row.is_archived,
    });
  }
  return [...byClassroom.values()].map(m => {
    const roles = [...m.roles].sort((a, b) => rank(a) - rank(b));
    return { ...m, roles, role: roles[0] };
  });
}
