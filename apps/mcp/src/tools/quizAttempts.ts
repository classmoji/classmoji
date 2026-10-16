/**
 * list_quiz_attempts — who has taken a quiz, who has not, and how each attempt
 * went, for the teaching team. The data the admin quiz results page builds
 * (admin.$class.quizzes_.$quizId): one row per STUDENT on the roster with every
 * attempt, the attempt that counts, and the late hours; plus the staff
 * previews, which are not students' work and are kept apart so they cannot be
 * mistaken for it.
 *
 * Tier: OWNER, TEACHER and ASSISTANT, as the web page (allowedRoles on the
 * results route). Where the classroom shows no quizzes (not Pro, switched off,
 * or no AI agent) it is refused, as the page 404s there.
 *
 * S1: the quiz is resolved through loadQuizInClassroom, so a quiz of another
 * classroom is the same not_found as an unknown id. Everything else is read
 * from that quiz and the authorized classroom: the attempts come with the quiz,
 * the roster and the hours bought are scoped to the classroom.
 *
 * The response is built field by field. The attempt rows are joined to full
 * user rows (contact and account fields among them); only an id, a login and a
 * name leave. Reading other people's results is audited, as the web page audits
 * its VIEW.
 *
 * Not here: an attempt's transcript and per-question results, and how an
 * attempt ended.
 */

import { ClassmojiService } from '@classmoji/services';
import { countingQuizScore, lateHours } from '@classmoji/utils';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { sanitizedSettings } from '../resources/shape.ts';
import { loadQuizInClassroom, ok, QUIZ_STAFF, requireClassroomCtx, writeAudit } from './shared.ts';

interface ListQuizAttemptsArgs {
  classroom: string;
  quiz_id: string;
}

interface AttemptRow {
  id: string;
  user_id: string;
  started_at: Date;
  completed_at: Date | null;
  partial_credit_percentage: number | null;
  first_attempt_percentage: number | null;
  total_duration_ms: number | bigint | null;
  unfocused_duration_ms: number | bigint | null;
  user?: { id: string; login?: string | null; name?: string | null } | null;
}

interface RosterStudent {
  id: string;
  login?: string | null;
  name?: string | null;
}

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

/** The share of an attempt's time the tab was focused, as the review page shows it. */
function focusPercentage(attempt: AttemptRow): number | null {
  const total = Number(attempt.total_duration_ms ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const unfocused = Math.max(0, Number(attempt.unfocused_duration_ms ?? 0));
  return Math.round((Math.max(total - unfocused, 0) / total) * 100);
}

const person = (user: RosterStudent | null | undefined, id: string) => ({
  id,
  login: user?.login ?? null,
  name: user?.name ?? null,
});

export const listQuizAttemptsTool: ToolDefinition<ListQuizAttemptsArgs> = {
  name: 'list_quiz_attempts',
  annotations: { openWorld: false },
  title: 'List quiz attempts',
  description:
    'For one quiz: every student on the roster with each of their attempts (id, started_at, ' +
    'completed_at, score and first_attempt_score as percentages, focus_percentage, late_hours, ' +
    'is_counting), the attempt that counts, current_score (its raw percentage) and ' +
    'counted_score (after the late penalty), and a status of NOT_STARTED, IN_PROGRESS or ' +
    'COMPLETED. Students with no attempt are listed, so this answers who has not started. ' +
    'Teaching staff’s own preview attempts are in staff_previews, never among students. ' +
    'Transcripts are not included. The teaching team only; the read is audited.',
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
    const assignment = quiz.assignment;
    const deadline = assignment?.student_deadline ?? null;
    const penalty = Number(sanitizedSettings(ctx).late_penalty_points_per_hour ?? 0) || 0;

    const [roster, hoursBought] = await Promise.all([
      ClassmojiService.classroomMembership.findUsersByRole(classroomId, 'STUDENT') as Promise<
        RosterStudent[]
      >,
      assignment && deadline
        ? ClassmojiService.token.netQuizExtensionHoursByStudent({
            classroomId,
            assignmentId: assignment.id,
          })
        : new Map<string, number>(),
    ]);

    const attemptsByUser = new Map<string, AttemptRow[]>();
    for (const attempt of quiz.attempts as AttemptRow[]) {
      const own = attemptsByUser.get(attempt.user_id) ?? [];
      own.push(attempt);
      attemptsByUser.set(attempt.user_id, own);
    }

    /** One person's attempts, newest first, with the attempt that counts marked. */
    const rowFor = (userId: string, who: RosterStudent | null | undefined, late: boolean) => {
      const own = attemptsByUser.get(userId) ?? [];
      // Lateness is measured for students on the roster only: anyone else's
      // attempts are previews and never late.
      const extensionHours = late ? (hoursBought.get(userId) ?? 0) : 0;
      const score = countingQuizScore(own, quiz.grading_strategy, {
        studentDeadline: late ? deadline : null,
        extensionHours,
        latePenaltyPerHour: penalty,
      });
      const attempts = [...own]
        .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
        .map(attempt => ({
          id: attempt.id,
          started_at: iso(attempt.started_at),
          completed_at: iso(attempt.completed_at),
          score: attempt.partial_credit_percentage ?? null,
          first_attempt_score: attempt.first_attempt_percentage ?? null,
          focus_percentage: focusPercentage(attempt),
          late_hours: late ? lateHours(attempt.completed_at, deadline, extensionHours) : 0,
          is_counting: attempt.id === score.counting_attempt_id,
        }));
      return {
        student: person(who ?? own[0]?.user, userId),
        status:
          own.length === 0
            ? ('NOT_STARTED' as const)
            : own.some(attempt => attempt.completed_at)
              ? ('COMPLETED' as const)
              : ('IN_PROGRESS' as const),
        attempts,
        counting_attempt_id: score.counting_attempt_id,
        current_score: score.raw_percentage,
        counted_score: score.grade,
      };
    };

    const rostered = new Set(roster.map(student => student.id));
    const students = roster.map(student => rowFor(student.id, student, true));
    const staffPreviews = [...attemptsByUser.keys()]
      .filter(userId => !rostered.has(userId))
      .map(userId => rowFor(userId, null, false));

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
        grading_strategy: quiz.grading_strategy,
        max_attempts: quiz.max_attempts,
        due_date: iso(deadline),
      },
      students,
      staff_previews: staffPreviews,
    });
  },
};
