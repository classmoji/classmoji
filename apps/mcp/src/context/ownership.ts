import getPrisma from '@classmoji/database';
import { ErrorCode, mcpError } from '../utils/errors.ts';

/**
 * Cross-classroom UUID guards.
 *
 * Every MCP write tool already authorizes the caller for some classroom via
 * `resolveClassroom()`. The remaining gap is target ownership: a caller who
 * knows or guesses a UUID from a different classroom could otherwise mutate
 * data they were never authorized for. These helpers load the target row,
 * verify it belongs to the resolved classroom, and throw a normalized MCP
 * error if not.
 *
 * All assert*InClassroom helpers pull only `classroom_id` (or the path that
 * leads to it) — no leaking of the row contents on failure. They throw
 * "not found in this classroom" rather than distinguishing missing vs
 * mismatched, so an attacker can't probe whether a UUID exists elsewhere.
 */

export async function assertModuleInClassroom(
  moduleId: string,
  classroomId: string
): Promise<void> {
  const m = await getPrisma().module.findUnique({
    where: { id: moduleId },
    select: { classroom_id: true },
  });
  if (!m || m.classroom_id !== classroomId) {
    throw mcpError('Module not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertAssignmentInClassroom(
  assignmentId: string,
  classroomId: string
): Promise<void> {
  const a = await getPrisma().assignment.findUnique({
    where: { id: assignmentId },
    select: { module: { select: { classroom_id: true } } },
  });
  if (!a || a.module.classroom_id !== classroomId) {
    throw mcpError('Assignment not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertRepositoryAssignmentInClassroom(
  repositoryAssignmentId: string,
  classroomId: string
): Promise<void> {
  const ra = await getPrisma().repositoryAssignment.findUnique({
    where: { id: repositoryAssignmentId },
    select: { repository: { select: { classroom_id: true } } },
  });
  if (!ra || ra.repository.classroom_id !== classroomId) {
    throw mcpError(
      'Repository assignment not found in this classroom',
      ErrorCode.InvalidRequest
    );
  }
}

export async function assertAssignmentGradeInClassroom(
  gradeId: string,
  classroomId: string
): Promise<void> {
  const g = await getPrisma().assignmentGrade.findUnique({
    where: { id: gradeId },
    select: {
      repository_assignment: {
        select: { repository: { select: { classroom_id: true } } },
      },
    },
  });
  if (!g || g.repository_assignment.repository.classroom_id !== classroomId) {
    throw mcpError('Grade not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertRegradeRequestInClassroom(
  regradeRequestId: string,
  classroomId: string
): Promise<void> {
  const r = await getPrisma().regradeRequest.findUnique({
    where: { id: regradeRequestId },
    select: { classroom_id: true },
  });
  if (!r || r.classroom_id !== classroomId) {
    throw mcpError('Regrade request not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertQuizInClassroom(
  quizId: string,
  classroomId: string
): Promise<void> {
  const q = await getPrisma().quiz.findUnique({
    where: { id: quizId },
    select: { classroom_id: true },
  });
  if (!q || q.classroom_id !== classroomId) {
    throw mcpError('Quiz not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertPageInClassroom(
  pageId: string,
  classroomId: string
): Promise<void> {
  const p = await getPrisma().page.findUnique({
    where: { id: pageId },
    select: { classroom_id: true },
  });
  if (!p || p.classroom_id !== classroomId) {
    throw mcpError('Page not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertSlideInClassroom(
  slideId: string,
  classroomId: string
): Promise<void> {
  const s = await getPrisma().slide.findUnique({
    where: { id: slideId },
    select: { classroom_id: true },
  });
  if (!s || s.classroom_id !== classroomId) {
    throw mcpError('Slide not found in this classroom', ErrorCode.InvalidRequest);
  }
}

export async function assertCalendarEventInClassroom(
  eventId: string,
  classroomId: string
): Promise<void> {
  const e = await getPrisma().calendarEvent.findUnique({
    where: { id: eventId },
    select: { classroom_id: true },
  });
  if (!e || e.classroom_id !== classroomId) {
    throw mcpError('Calendar event not found in this classroom', ErrorCode.InvalidRequest);
  }
}

/**
 * Verify the user holds an accepted membership in this classroom — used for
 * grader assignment / membership-update tools where the target user must
 * already be in the classroom they're being granted a role within.
 */
export async function assertUserMemberOfClassroom(
  userId: string,
  classroomId: string
): Promise<void> {
  const m = await getPrisma().classroomMembership.findFirst({
    where: { user_id: userId, classroom_id: classroomId, has_accepted_invite: true },
    select: { id: true },
  });
  if (!m) {
    throw mcpError('User is not a member of this classroom', ErrorCode.InvalidRequest);
  }
}

/**
 * For student-self operations on a repository assignment (regrade_create,
 * tokens_purchase_extension): verify the repo belongs to the classroom AND
 * to the calling student (either as the individual repo owner or via team
 * membership for team modules).
 */
export async function assertStudentOwnsRepositoryAssignment(
  repositoryAssignmentId: string,
  studentId: string,
  classroomId: string
): Promise<void> {
  const ra = await getPrisma().repositoryAssignment.findUnique({
    where: { id: repositoryAssignmentId },
    select: {
      repository: {
        select: {
          classroom_id: true,
          student_id: true,
          team: {
            select: {
              memberships: {
                where: { user_id: studentId },
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });
  if (!ra) {
    throw mcpError(
      'Repository assignment not found in this classroom',
      ErrorCode.InvalidRequest
    );
  }
  if (ra.repository.classroom_id !== classroomId) {
    throw mcpError(
      'Repository assignment not found in this classroom',
      ErrorCode.InvalidRequest
    );
  }
  const isOwner =
    ra.repository.student_id === studentId ||
    (ra.repository.team?.memberships.length ?? 0) > 0;
  if (!isOwner) {
    throw mcpError(
      'You do not own this repository assignment',
      ErrorCode.InvalidRequest
    );
  }
}
