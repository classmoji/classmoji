/**
 * list_quiz_attempts — who has taken a quiz, who has not, and how each attempt
 * went, for the teaching team. The rows the admin quiz results page builds
 * (admin.$class.quizzes_.$quizId): the same reads (quizAttempt.findByQuiz, the
 * STUDENT roster, each student's net extension hours when the quiz has a due
 * date, the classroom's late penalty) fed to the same `buildQuizResultRows`
 * (@classmoji/utils), so a row here is the row the page shows, counted zeros
 * included.
 *
 * Tier: OWNER, TEACHER and ASSISTANT, as the web page (allowedRoles on the
 * results route). Where the classroom shows no quizzes (not Pro, switched off,
 * or no AI agent) it is refused, as the page 404s there.
 *
 * S1: the quiz is resolved through loadQuizInClassroom, so a quiz of another
 * classroom is the same not_found as an unknown id. Everything else is read
 * from that quiz and the authorized classroom.
 *
 * WHO TOOK IT: only someone on the classroom's STUDENT roster is a student
 * (`students`); anyone else's attempts are never late and never a grade. Of
 * those, a current staff member's are previews (`staff_previews`); the rest
 * are the work of someone no longer in the classroom (`former_members`,
 * usually a removed student: attempt rows outlive the membership). `summary`
 * counts the roster only, plus how many previews and former members there are.
 *
 * Grades are emoji on the classroom's own scale (quizGradeEmoji.ts), never a
 * number: each attempt's grade and first-try grade, and per student the
 * counting attempt's grade before and after the late penalty (a counted zero
 * is the scale's emoji for 0).
 *
 * The response is built field by field. The attempt and roster rows are
 * joined to full user rows (contact and account fields, the staff note and
 * the letter override among them); only an id, a login on the classroom's git
 * provider and a name leave. Reading other people's results is audited, as
 * the web page audits its VIEW.
 *
 * Not here: an attempt's transcript and per-question results (get_quiz_attempt).
 */

import { ClassmojiService } from '@classmoji/services';
import {
  buildQuizResultRows,
  type QuizAttemptSource,
  type QuizResultAttempt,
  type QuizResultStudent,
} from '@classmoji/utils';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { orgProvider, sanitizedSettings } from '../resources/shape.ts';
import { emojiFor, loadQuizEmojiScale } from './quizGradeEmoji.ts';
import { loadQuizInClassroom, ok, QUIZ_STAFF, requireClassroomCtx, writeAudit } from './shared.ts';

interface ListQuizAttemptsArgs {
  classroom: string;
  quiz_id: string;
}

/** The attempt columns read beyond the ones `buildQuizResultRows` takes. */
interface AttemptRow extends QuizAttemptSource {
  last_activity?: Date | string | null;
}

interface Member {
  id: string;
  login?: string | null;
  name?: string | null;
}

const iso = (value: Date | string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Where a row stands on the quiz: COMPLETED once any attempt is completed,
 * else IN_PROGRESS with an attempt open, else NOT_STARTED.
 */
const statusOf = (row: QuizResultStudent) =>
  row.attempts.length === 0
    ? ('NOT_STARTED' as const)
    : row.attempts.some(attempt => attempt.completed_at)
      ? ('COMPLETED' as const)
      : ('IN_PROGRESS' as const);

export const listQuizAttemptsTool: ToolDefinition<ListQuizAttemptsArgs> = {
  name: 'list_quiz_attempts',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'List quiz attempts',
  description:
    "A quiz's results, as its web results page shows them. students: every student on the " +
    'roster, not-started ones included, each with status (NOT_STARTED, IN_PROGRESS, ' +
    'COMPLETED), every attempt (id, started_at, completed_at, last_activity while open, ' +
    'grade_emoji, first_attempt_emoji, focus_percentage, late_hours, is_counting), the ' +
    'attempt that counts, current_emoji (its grade) and counted_emoji (after the late ' +
    'penalty), and counts_as_zero (no completed attempt past the due date). Grades are emoji ' +
    "on the classroom's own scale (score-N badges on the numeric scale), never numbers. " +
    'staff_previews and former_members (people no longer in the classroom) are kept apart, ' +
    'never late or graded. summary counts the roster. For one attempt and its transcript use ' +
    'get_quiz_attempt. The teaching team only; the read is audited.',
  scope: 'read',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id (see list_quizzes)'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
      throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
    }

    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    const assignment = quiz.assignment ?? null;
    const deadline = assignment?.student_deadline ?? null;
    // The web's rule: a penalty that is not a number is none.
    const setting: unknown = sanitizedSettings(ctx).late_penalty_points_per_hour;
    const penalty = typeof setting === 'number' ? setting : 0;

    // The results page's reads, the classroom's git provider naming each
    // login, and the staff memberships that tell a preview from a former
    // member's work.
    const [attempts, roster, staff, extensionHours, scale] = await Promise.all([
      ClassmojiService.quizAttempt.findByQuiz(quiz.id, orgProvider(ctx)) as Promise<AttemptRow[]>,
      ClassmojiService.classroomMembership.findUsersByRole(classroomId, 'STUDENT') as Promise<
        Member[]
      >,
      ClassmojiService.classroomMembership.findUsersByRoles(classroomId, [
        ...QUIZ_STAFF,
      ]) as Promise<Member[]>,
      assignment && deadline
        ? ClassmojiService.token.netQuizExtensionHoursByStudent({
            classroomId,
            assignmentId: assignment.id,
          })
        : null,
      loadQuizEmojiScale(classroomId),
    ]);
    const rosterIds = new Set(roster.map(student => String(student.id)));
    const staffIds = new Set(staff.map(member => String(member.id)));
    const now = new Date();
    const { students: rows } = buildQuizResultRows({
      attempts,
      gradingStrategy: quiz.grading_strategy,
      viewerId: ctx.viewer.userId,
      late:
        deadline && extensionHours
          ? {
              studentDeadline: deadline,
              latePenaltyPerHour: penalty,
              extensionHours,
              studentIds: rosterIds,
            }
          : null,
      roster: { students: roster, assignment, now },
    });

    // A member's login and name come from their membership; a former
    // member's from the attempt join. Both name the classroom's git provider.
    const members = new Map([...staff, ...roster].map(member => [String(member.id), member]));
    const rowsById = new Map(attempts.map(attempt => [attempt.id, attempt]));

    const attemptView = (attempt: QuizResultAttempt) => ({
      id: attempt.id,
      started_at: iso(attempt.started_at),
      completed_at: iso(attempt.completed_at),
      ...(attempt.completed_at
        ? {}
        : { last_activity: iso(rowsById.get(attempt.id)?.last_activity) }),
      // Grades are a completed attempt's only, as on the review page.
      grade_emoji: attempt.completed_at ? emojiFor(attempt.partialCreditScore, scale) : null,
      first_attempt_emoji: attempt.completed_at ? emojiFor(attempt.firstAttemptScore, scale) : null,
      focus_percentage: attempt.focusMetrics?.percentage ?? null,
      late_hours: attempt.lateHours,
      is_counting: attempt.isCounting,
    });

    const rowView = (row: QuizResultStudent) => {
      const member = members.get(row.userId);
      return {
        student: {
          id: row.userId,
          login: member?.login ?? row.user.login ?? null,
          name: member?.name ?? row.user.name ?? null,
        },
        status: statusOf(row),
        attempt_count: row.attemptCount,
        attempts: row.attempts.map(attemptView),
        counting_attempt_id: row.countingAttemptId,
        current_emoji: emojiFor(row.currentScore, scale),
        counted_emoji: emojiFor(row.countedScore, scale),
        counts_as_zero: row.countsAsZero,
        late_hours: row.lateHours,
      };
    };

    const students = rows.filter(row => rosterIds.has(row.userId));
    const others = rows.filter(row => !rosterIds.has(row.userId));
    const staffPreviews = others.filter(row => staffIds.has(row.userId));
    const formerMembers = others.filter(row => !staffIds.has(row.userId));
    const withStatus = (status: ReturnType<typeof statusOf>) =>
      students.filter(row => statusOf(row) === status).length;

    await writeAudit(ctx, {
      resource_type: 'QUIZ_DETAILS',
      resource_id: quiz.id,
      action: 'VIEW',
      data: {
        tool: 'quiz.attempts.view',
        via: 'mcp',
        mcp_tool: 'list_quiz_attempts',
        quiz_id: quiz.id,
        students: students.length,
      },
    });

    return ok({
      quiz: {
        id: quiz.id,
        name: quiz.name,
        grading_strategy: quiz.grading_strategy ?? null,
        max_attempts: quiz.max_attempts ?? null,
        due_date: iso(deadline),
      },
      summary: {
        roster_students: rosterIds.size,
        not_started: withStatus('NOT_STARTED'),
        in_progress: withStatus('IN_PROGRESS'),
        completed: withStatus('COMPLETED'),
        counts_as_zero: students.filter(row => row.countsAsZero).length,
        staff_previews: staffPreviews.length,
        former_members: formerMembers.length,
      },
      students: students.map(rowView),
      staff_previews: staffPreviews.map(rowView),
      former_members: formerMembers.map(rowView),
    });
  },
};
