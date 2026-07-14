/**
 * `repos` + `grades-mine` — classmoji://{org}/{slug}/repos, …/grades-mine.
 *
 * Naming trap (plan §2): a `Repository` is the instructor-authored assignment
 * CONTAINER ("Lab 1"), not a git repo; `Assignment` is the due-dated slice
 * within it; the student's actual instance is a `GitRepoAssignment` on their
 * `GitRepo`.
 *
 * repos (any member — mirrors student.$class.repos allowedRoles):
 *   - Staff see every container + assignment incl. unpublished
 *     (repository.findByClassroomId, as the admin repos loader does).
 *   - Students see only is_published containers with is_published assignments
 *     (repository.findPublished), further narrowed — as the student route
 *     does — to containers they own a GitRepo for, each assignment annotated
 *     with their own submission. Grades appear ONLY when
 *     Assignment.grades_released (locked decision 7): the web loader ships
 *     unreleased grades and relies on the client not to render them — a data
 *     API must not.
 *   - The student nav flag show_repos=false returns {enabled:false} for
 *     students (nav parity; staff unaffected).
 *
 * grades-mine (STUDENT self):
 *   Mirrors the student dashboard's feedback list: filter =
 *   assignment.grades_released && grades.length > 0 — grades_released is the
 *   SOLE visibility gate. Same DTO fields (grader identity narrowed to
 *   id+name). Queries are classroom_id-scoped (not slug-scoped like
 *   helper.findAllAssignmentsForStudent) because slugs are only unique per
 *   git org.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ResourceDefinition, ToolContext } from '../mcp/registry.ts';
import {
  MEMBER,
  STUDENT_ONLY,
  classroomCtx,
  gradeRefs,
  graderRefs,
  isStaff,
  issueUrl,
  orgLogin,
  type SubmissionLike,
} from './shape.ts';

interface AssignmentRow {
  id: string;
  title: string;
  slug?: string | null;
  weight: number;
  is_published: boolean;
  description?: string;
  student_deadline?: Date | null;
  grader_deadline?: Date | null;
  tokens_per_hour: number;
  release_at?: Date | null;
  grades_released: boolean;
}

interface RepositoryRow {
  id: string;
  title: string;
  slug?: string | null;
  description?: string | null;
  is_published: boolean;
  weight: number;
  type: string;
  is_extra_credit: boolean;
  team_formation_mode?: string | null;
  max_team_size?: number | null;
  assignments: AssignmentRow[];
  tag?: { name?: string | null } | null;
}

/** The viewer's own GitRepoAssignments in this classroom (individual + team). */
async function findMySubmissions(ctx: ToolContext): Promise<SubmissionLike[]> {
  const { classroomId } = classroomCtx(ctx);
  // Same service call the webapp's helper uses, but scoped by classroom_id
  // instead of slug (slug is ambiguous across git orgs).
  return (await ClassmojiService.gitRepoAssignment.findForUser({
    git_repo: {
      classroom_id: classroomId,
      OR: [
        { student_id: ctx.viewer.userId },
        { team: { memberships: { some: { user_id: ctx.viewer.userId } } } },
      ],
    },
  })) as SubmissionLike[];
}

export const reposResource: ResourceDefinition = {
  name: 'repos',
  uriTemplate: 'classmoji://{org}/{slug}/repos',
  title: 'Assignment containers (repos)',
  description:
    'Assignment containers ("repos") with their due-dated assignments. Staff see all incl. ' +
    'unpublished; students see published-only containers they have a git repo for, with their ' +
    'own submission status per assignment (grades only after release).',
  scope: 'read',
  roles: MEMBER,
  handler: async (_vars, ctx) => {
    const { classroomId, role, classroom } = classroomCtx(ctx);
    const staff = isStaff(role);

    if (!staff) {
      const settings = (classroom as unknown as { settings?: { show_repos?: boolean } | null })
        .settings;
      if (settings?.show_repos === false) {
        return { enabled: false, repositories: [] };
      }
    }

    if (staff) {
      const repos = (await ClassmojiService.repository.findByClassroomId(
        classroomId
      )) as RepositoryRow[];
      return {
        enabled: true,
        repositories: repos.map(r => ({
          id: r.id,
          title: r.title,
          slug: r.slug ?? null,
          description: r.description ?? null,
          type: r.type,
          weight: r.weight,
          is_published: r.is_published,
          is_extra_credit: r.is_extra_credit,
          team_formation_mode: r.team_formation_mode ?? null,
          max_team_size: r.max_team_size ?? null,
          tag: r.tag?.name ?? null,
          assignments: r.assignments.map(a => ({
            id: a.id,
            title: a.title,
            slug: a.slug ?? null,
            weight: a.weight,
            is_published: a.is_published,
            student_deadline: a.student_deadline ?? null,
            grader_deadline: a.grader_deadline ?? null,
            release_at: a.release_at ?? null,
            grades_released: a.grades_released,
            tokens_per_hour: a.tokens_per_hour,
          })),
        })),
      };
    }

    // STUDENT: published containers/assignments only, narrowed to owned repos.
    const [repos, submissions] = await Promise.all([
      ClassmojiService.repository.findPublished(classroomId) as Promise<RepositoryRow[]>,
      findMySubmissions(ctx),
    ]);
    const org = orgLogin(ctx);
    const ownedRepositoryIds = new Set(
      submissions.map(s => s.git_repo?.repository_id).filter(Boolean)
    );
    const byAssignment = new Map(submissions.map(s => [s.assignment?.id, s]));

    return {
      enabled: true,
      repositories: repos
        .filter(r => ownedRepositoryIds.has(r.id))
        .map(r => ({
          id: r.id,
          title: r.title,
          slug: r.slug ?? null,
          description: r.description ?? null,
          type: r.type,
          weight: r.weight,
          is_extra_credit: r.is_extra_credit,
          assignments: r.assignments.map(a => {
            const mine = byAssignment.get(a.id);
            return {
              id: a.id,
              title: a.title,
              slug: a.slug ?? null,
              weight: a.weight,
              student_deadline: a.student_deadline ?? null,
              grades_released: a.grades_released,
              tokens_per_hour: a.tokens_per_hour,
              my_submission: mine
                ? {
                    id: mine.id,
                    status: mine.status,
                    closed_at: mine.closed_at ?? null,
                    is_late_override: mine.is_late_override ?? false,
                    issue_url: issueUrl(org, mine),
                    // Locked decision 7: grades only after release.
                    grades: a.grades_released ? gradeRefs(mine.grades) : [],
                    graders: graderRefs(mine.graders),
                  }
                : null,
            };
          }),
        })),
    };
  },
};

export const gradesMineResource: ResourceDefinition = {
  name: 'grades-mine',
  uriTemplate: 'classmoji://{org}/{slug}/grades-mine',
  title: 'My released grades',
  description:
    'Your own graded submissions in this classroom — only assignments whose grades have been ' +
    'released (Assignment.grades_released). Students only.',
  scope: 'read',
  roles: STUDENT_ONLY,
  handler: async (_vars, ctx) => {
    const submissions = await findMySubmissions(ctx);
    const org = orgLogin(ctx);

    // The student dashboard's exact feedback filter: released AND has grades.
    const released = submissions.filter(
      s => s.assignment?.grades_released && (s.grades?.length ?? 0) > 0
    );

    return {
      count: released.length,
      grades: released.map(s => ({
        id: s.id,
        assignment_title: s.assignment?.title ?? null,
        repository_title: s.git_repo?.repository?.title ?? null,
        team: s.git_repo?.team ? { id: s.git_repo.team.id, name: s.git_repo.team.name } : null,
        status: s.status,
        closed_at: s.closed_at ?? null,
        grades: gradeRefs(s.grades),
        graders: graderRefs(s.graders),
        issue_url: issueUrl(org, s),
      })),
    };
  },
};
