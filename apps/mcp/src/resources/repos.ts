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
 *     (repository.findByClassroomId, as the admin repos loader does), with
 *     every field repo_update edits (template, team settings, tag_id, project
 *     template) — staff view only; the student view does not carry them. Each
 *     assignment also names the module it belongs to (`module_id`, the value
 *     assignment_update moves), staff view only for the same reason.
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
 *   Repository submissions mirror the student dashboard's feedback list:
 *   filter = assignment.grades_released && grades.length > 0 —
 *   grades_released is the SOLE visibility gate for them. Same DTO fields
 *   (grader identity narrowed to id+name). Queries are classroom_id-scoped
 *   (not slug-scoped like helper.findAllAssignmentsForStudent) because slugs
 *   are only unique per git org.
 *
 *   Quiz scores (`quiz_grades`) show as soon as an attempt is scored, as on the
 *   web: one row per quiz item the grade engine counts for this student
 *   (quizGradeItems.loadQuizGradeItems, the loader every total uses), with the
 *   RAW percentage of the attempt that counts and that attempt's late hours —
 *   students see the raw score and the lateness, never the penalised value,
 *   as for repositories. A quiz whose deadline (plus the hours bought on it)
 *   passed with no attempt is a counted 0 (`counts_as_zero`). Gated on
 *   entitlement.quizzesVisibleOrThrow, the predicate the totals use: where
 *   quizzes are hidden the key is absent, and a failed lookup fails the read
 *   rather than dropping the quizzes.
 *
 *   final_grade / estimated_grade: the STUDENT caller gets the grade line the
 *   student dashboard shows, from the same entry point
 *   (`helper.gradeSummaryForStudent` over the submissions read above, which
 *   go through the same `findForUser` include as the dashboard's
 *   `findAllAssignmentsForStudent`). Where the owner released final grades
 *   and the student has one: `final_grade: {letter}` (the gradebook's Letter
 *   column, override included) and no estimated_grade. Otherwise, where the
 *   owner turned on `show_grades_to_students`: `estimated_grade`, over
 *   released grades only and never the override; null when there is nothing
 *   to estimate or the read failed (logged), as on the dashboard. Both keys
 *   are absent where neither setting is on, with nothing read for them.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { countingQuizScore, effectiveDeadline, effectiveTokensPerHour } from '@classmoji/utils';
import type { ResourceDefinition, ToolContext } from '../mcp/registry.ts';
import {
  MEMBER,
  STUDENT_ONLY,
  classroomCtx,
  gradeRefs,
  graderRefs,
  isStaff,
  issueUrl,
  orgGit,
  sanitizedSettings,
  type SubmissionLike,
} from './shape.ts';

interface AssignmentRow {
  id: string;
  module_id?: string | null;
  title: string;
  slug?: string | null;
  weight: number;
  is_extra_credit?: boolean;
  is_published: boolean;
  description?: string;
  student_deadline?: Date | null;
  grader_deadline?: Date | null;
  /** Empty = the classroom's default price. */
  tokens_per_hour: number | null;
  release_at?: Date | null;
  grades_released: boolean;
}

interface RepositoryRow {
  id: string;
  title: string;
  slug?: string | null;
  description?: string | null;
  is_published: boolean;
  type: string;
  template?: string | null;
  tag_id?: string | null;
  team_formation_mode?: string | null;
  team_formation_deadline?: Date | null;
  max_team_size?: number | null;
  project_template_id?: string | null;
  project_template_title?: string | null;
  assignments: AssignmentRow[];
  tag?: { id?: string; name?: string | null } | null;
}

/** grades-mine's description; my_grades (tools/reads.ts) carries the same text. */
export const GRADES_MINE_DESCRIPTION =
  'Your own grades in this classroom. Repository submissions appear only once their grades ' +
  'are released (Assignment.grades_released). Quiz scores (quiz_grades) appear as soon as an ' +
  'attempt is scored: the raw percentage of the attempt that counts, with how many hours late ' +
  'it was (after any hours you bought), or 0 with counts_as_zero when the deadline passed ' +
  'with no attempt. final_grade {letter}, present once the instructor releases final grades, ' +
  'is your final course grade. Otherwise estimated_grade, present only where the instructor ' +
  'shows it, is the estimate on your dashboard from released grades: {kind:"letter",letter,' +
  'count} or {kind:"emoji",emoji,count}; null when there is none. Students only.';

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
    'unpublished, each assignment with the module_id it belongs to; students see published-only ' +
    'containers they have a git repo for, with their own submission status per assignment ' +
    '(grades only after release).',
  scope: 'read',
  roles: MEMBER,
  handler: async (_vars, ctx) => {
    const { classroomId, role, classroom } = classroomCtx(ctx);
    const staff = isStaff(role);
    // An assignment without its own extension price pays the classroom's.
    // tokens_per_hour stays the assignment's own value (null = follows the
    // classroom), the same as every other tool reports and assignment_update
    // writes, so reading it back and writing it never pins the classroom's
    // price onto the assignment. effective_tokens_per_hour is what one hour
    // actually costs.
    const classroomTokensPerHour =
      (classroom as unknown as { settings?: { default_tokens_per_hour?: number } | null }).settings
        ?.default_tokens_per_hour ?? 0;
    const price = (own: number | null) => ({
      tokens_per_hour: own,
      effective_tokens_per_hour: effectiveTokensPerHour(own, classroomTokensPerHour),
    });

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
          is_published: r.is_published,
          // Everything repo_update edits, so an agent can read before it writes.
          template: r.template ?? null,
          team_formation_mode: r.team_formation_mode ?? null,
          team_formation_deadline: r.team_formation_deadline ?? null,
          max_team_size: r.max_team_size ?? null,
          project_template_id: r.project_template_id ?? null,
          project_template_title: r.project_template_title ?? null,
          // `tag` stays the name (existing shape); `tag_id` is what the write
          // tools take.
          tag: r.tag?.name ?? null,
          tag_id: r.tag_id ?? null,
          assignments: r.assignments.map(a => ({
            id: a.id,
            title: a.title,
            slug: a.slug ?? null,
            // The module the assignment lives in (see list_modules);
            // assignment_update with module_id moves it.
            module_id: a.module_id ?? null,
            weight: a.weight,
            is_extra_credit: a.is_extra_credit ?? false,
            is_published: a.is_published,
            student_deadline: a.student_deadline ?? null,
            grader_deadline: a.grader_deadline ?? null,
            release_at: a.release_at ?? null,
            grades_released: a.grades_released,
            ...price(a.tokens_per_hour),
          })),
        })),
      };
    }

    // STUDENT: published containers/assignments only, narrowed to owned repos.
    const [repos, submissions] = await Promise.all([
      ClassmojiService.repository.findPublished(classroomId) as Promise<RepositoryRow[]>,
      findMySubmissions(ctx),
    ]);
    const git = orgGit(ctx);
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
          assignments: r.assignments.map(a => {
            const mine = byAssignment.get(a.id);
            return {
              id: a.id,
              title: a.title,
              slug: a.slug ?? null,
              weight: a.weight,
              is_extra_credit: a.is_extra_credit ?? false,
              student_deadline: a.student_deadline ?? null,
              grades_released: a.grades_released,
              ...price(a.tokens_per_hour),
              my_submission: mine
                ? {
                    id: mine.id,
                    status: mine.status,
                    closed_at: mine.closed_at ?? null,
                    is_late_override: mine.is_late_override ?? false,
                    issue_url: issueUrl(git, mine),
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

/**
 * The caller's quiz rows for grades-mine, or null where quizzes are hidden.
 * Which quizzes have a row, and which are a counted 0, comes from the grade
 * loader; the counting attempt is re-derived from the same inputs with the
 * same rule (`countingQuizScore`: the strategy picks among late-penalised
 * scores), so the row names the attempt the total counts.
 */
async function myQuizGrades(ctx: ToolContext) {
  const { classroomId } = classroomCtx(ctx);
  const quizzesVisible = await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId);
  if (!quizzesVisible) return null;

  const studentId = ctx.viewer.userId;
  const now = new Date();
  const items =
    (
      await ClassmojiService.quizGradeItems.loadQuizGradeItems({
        classroomId,
        quizzesVisible,
        userIds: [studentId],
        now,
      })
    ).get(studentId) ?? [];
  if (items.length === 0) return [];

  const itemByAssignment = new Map(items.map(item => [item.assignment_id, item]));
  const assignmentIds = [...itemByAssignment.keys()];
  const assignments = await getPrisma().assignment.findMany({
    where: { id: { in: assignmentIds }, type: 'QUIZ', module: { classroom_id: classroomId } },
    select: {
      id: true,
      title: true,
      quiz_id: true,
      student_deadline: true,
      module: { select: { id: true, title: true } },
      quiz: { select: { grading_strategy: true } },
    },
    orderBy: [{ student_deadline: 'asc' }, { title: 'asc' }],
  });
  const quizIds = assignments.flatMap(a => (a.quiz_id ? [a.quiz_id] : []));
  const [attempts, hours] = await Promise.all([
    ClassmojiService.quizAttempt.findForUserByQuizIds(studentId, quizIds),
    ClassmojiService.quizGradeItems.netQuizExtensionHours({
      classroomId,
      studentId,
      assignmentIds,
    }),
  ]);
  const penalty = Number(sanitizedSettings(ctx).late_penalty_points_per_hour ?? 0) || 0;

  return assignments.flatMap(a => {
    const item = itemByAssignment.get(a.id);
    if (!item) return [];
    const extensionHours = hours.get(a.id) ?? 0;
    const score = item.counts_as_zero
      ? null
      : countingQuizScore(
          attempts.filter(t => t.quiz_id === a.quiz_id),
          a.quiz?.grading_strategy,
          {
            studentDeadline: a.student_deadline,
            extensionHours,
            latePenaltyPerHour: penalty,
          }
        );
    return [
      {
        assignment_id: a.id,
        quiz_id: a.quiz_id,
        title: a.title,
        module: a.module ? { id: a.module.id, title: a.module.title } : null,
        student_deadline: a.student_deadline ?? null,
        // The due date with the hours this student bought on it.
        effective_deadline: effectiveDeadline(a.student_deadline, extensionHours),
        // The raw score of the attempt that counts; 0 for a counted zero.
        percentage: item.counts_as_zero ? 0 : (score?.raw_percentage ?? null),
        late_hours: score?.late_hours ?? 0,
        counts_as_zero: item.counts_as_zero,
        counting_attempt_id: score?.counting_attempt_id ?? null,
        completed_at: score?.counting?.completed_at ?? null,
      },
    ];
  });
}

type SummaryInput = Parameters<typeof ClassmojiService.helper.gradeSummaryForStudent>[0];

/** Whether the caller is shown a grade line: the student dashboard's predicate. */
function showsGradeSummary(ctx: ToolContext): boolean {
  return ClassmojiService.helper.showsGradeSummary(
    classroomCtx(ctx).role,
    sanitizedSettings(ctx) as SummaryInput['settings']
  );
}

/**
 * The caller's grade line, from the same entry point and inputs as the
 * student dashboard. Fails soft as the dashboard does: a failed read is
 * logged and gives null, never a failed my_grades.
 */
async function myGradeSummary(ctx: ToolContext, submissions: SubmissionLike[]) {
  const { classroomId, membership, role } = classroomCtx(ctx);
  const userId = ctx.viewer.userId;
  try {
    return await ClassmojiService.helper.gradeSummaryForStudent({
      role,
      classroomId,
      userId,
      // findForUser rows: the assignment, grades and the computed lateness
      // fields the grade reads are all loaded (SubmissionLike narrows them).
      submissions: submissions as unknown as SummaryInput['submissions'],
      letterOverride: membership.letter_grade,
      settings: sanitizedSettings(ctx) as SummaryInput['settings'],
    });
  } catch (error: unknown) {
    console.error('[mcp grades-mine] grade summary failed', { classroomId, userId }, error);
    return null;
  }
}

/**
 * The payload keys for a grade line: `final_grade` when the student has a
 * released final grade; else `estimated_grade` (null allowed) where the
 * estimate is on; else none.
 */
function gradeSummaryKeys(
  ctx: ToolContext,
  summary: Awaited<ReturnType<typeof myGradeSummary>> | undefined
) {
  if (summary === undefined) return {};
  if (summary?.kind === 'final') return { final_grade: { letter: summary.letter } };
  if (sanitizedSettings(ctx).show_grades_to_students === true) {
    return { estimated_grade: summary };
  }
  return {};
}

export const gradesMineResource: ResourceDefinition = {
  name: 'grades-mine',
  uriTemplate: 'classmoji://{org}/{slug}/grades-mine',
  title: 'My grades',
  description: GRADES_MINE_DESCRIPTION,
  scope: 'read',
  roles: STUDENT_ONLY,
  handler: async (_vars, ctx) => {
    const submissionsPromise = findMySubmissions(ctx);
    const [submissions, quizGrades, gradeSummary] = await Promise.all([
      submissionsPromise,
      myQuizGrades(ctx),
      // Started as soon as the submissions arrive; nothing is read when off.
      showsGradeSummary(ctx)
        ? submissionsPromise.then(rows => myGradeSummary(ctx, rows))
        : Promise.resolve(undefined),
    ]);
    const git = orgGit(ctx);

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
        issue_url: issueUrl(git, s),
      })),
      // Absent where the classroom hides quizzes: no trace of them.
      ...(quizGrades ? { quiz_grades: quizGrades } : {}),
      // Absent where the classroom shows students neither a final grade nor an estimate.
      ...gradeSummaryKeys(ctx, gradeSummary),
    };
  },
};
