/**
 * `roster` + `teams` — classmoji://{org}/{slug}/roster, …/teams.
 *
 * roster (TEACHING TEAM, with OWNER-only grade fields):
 *   The web's roster route (admin.$class.students) READS at the teaching-team
 *   tier and applies exactly this split in its loader: identity plus the
 *   grader/invite flags for the whole teaching team, with contact PII
 *   (`email`, `provider_email`, `school_id`) and the membership grade fields
 *   (`letter_grade`, `comment`) added for an OWNER alone. Its MUTATIONS stay
 *   OWNER-only and carry their own gate.
 *
 *   The grade fields are NOT owner-only everywhere: the gradebook
 *   (admin.$class.grades, OWNER + TEACHER, also served at /teacher) exists to
 *   show them, which is why they travel with the membership there. They stay
 *   owner-only on the ROSTER, and this resource mirrors the roster.
 *
 *   Identity alone was never the sensitive part: the web already exposes every
 *   student's identity to the whole teaching team through the grading routes
 *   (assistant.$class_.grading → gitRepoAssignment.findByClassroomId includes
 *   git_repo.student).
 *
 *   There is deliberately no student-facing roster (nothing to mirror).
 *
 * teams (any member):
 *   Web reality: admin.$class.teams (OWNER) returns members as FULL User
 *   rows; the student team view (student.$class.repos_.$repo.team) narrows to
 *   {id,name,login,provider_id}. Mirror the narrow select for everyone.
 *   Tiers: the teaching team sees every team in the classroom; a STUDENT sees
 *   the teams they are a member of, and only those. The web has no
 *   classroom-wide team list for students, so own-teams-only is the closest
 *   mirror. It does show a student teams they have not joined in one place —
 *   the self-formed team flow (student.$class.repos_.$repo.team) — but that
 *   scopes its candidates by TAG through team.findByTagId and never reads this
 *   resource, so it is unaffected.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ResourceDefinition } from '../mcp/registry.ts';
import { MEMBER, TEACHING_TEAM, classroomCtx, publicUser } from './shape.ts';

interface RosterRow {
  id: string;
  name?: string | null;
  login?: string | null;
  image?: string | null;
  email?: string | null;
  school_id?: string | null;
  is_grader: boolean;
  has_accepted_invite: boolean;
  letter_grade?: string | null;
  comment?: string | null;
}

export const rosterResource: ResourceDefinition = {
  name: 'roster',
  uriTemplate: 'classmoji://{org}/{slug}/roster',
  title: 'Student roster',
  description:
    'Students enrolled in the classroom (teaching team only). OWNER additionally sees contact ' +
    'fields and per-student letter_grade/comment overrides.',
  scope: 'read',
  roles: TEACHING_TEAM,
  handler: async (_vars, ctx) => {
    const { classroomId, role } = classroomCtx(ctx);
    const students = (await ClassmojiService.classroomMembership.findUsersByRole(
      classroomId,
      'STUDENT'
    )) as RosterRow[];

    const isOwner = role === 'OWNER';
    return {
      count: students.length,
      students: students.map(s => ({
        ...publicUser(s),
        is_grader: s.is_grader,
        has_accepted_invite: s.has_accepted_invite,
        // OWNER-only fields (mirrors the requireClassroomAdmin roster route).
        ...(isOwner
          ? {
              email: s.email ?? null,
              school_id: s.school_id ?? null,
              letter_grade: s.letter_grade ?? null,
              comment: s.comment ?? null,
            }
          : {}),
      })),
    };
  },
};

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  is_visible: boolean;
  memberships?: Array<{
    user?: { id: string; name?: string | null; login?: string | null; image?: string | null };
  }>;
  tags?: Array<{ tag?: { name?: string | null } | null }>;
}

export const teamsResource: ResourceDefinition = {
  name: 'teams',
  uriTemplate: 'classmoji://{org}/{slug}/teams',
  title: 'Teams',
  description:
    'Teams in the classroom with member identities (id, name, login only — no contact PII). ' +
    'Students see the teams they belong to; the teaching team sees all teams.',
  scope: 'read',
  roles: MEMBER,
  handler: async (_vars, ctx) => {
    const { classroomId, role } = classroomCtx(ctx);
    const teams = (await ClassmojiService.team.findByClassroomId(classroomId)) as TeamRow[];

    const viewerId = ctx.viewer.userId;
    // A student's team list is their OWN teams. Membership is the whole test —
    // `is_visible` does not widen it. The web has no classroom-wide team list
    // for students; the one place it shows a student teams they are not in is
    // the tag-scoped join flow, which selects candidates by TAG
    // (team.findByTagId) rather than by this classroom-wide listing.
    const visible =
      role === 'STUDENT'
        ? teams.filter(t => (t.memberships ?? []).some(m => m.user?.id === viewerId))
        : teams;

    return {
      count: visible.length,
      teams: visible.map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        is_visible: t.is_visible,
        members: (t.memberships ?? []).map(m => publicUser(m.user)).filter(Boolean),
        tags: (t.tags ?? []).map(tt => tt.tag?.name).filter(Boolean),
      })),
    };
  },
};
