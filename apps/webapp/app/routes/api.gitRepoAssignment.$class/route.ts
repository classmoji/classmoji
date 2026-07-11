import { data as errorResponse } from 'react-router';
import { namedAction } from 'remix-utils/named-action';

import { tasks } from '@trigger.dev/sdk';

import { ClassmojiService, HelperService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import {
  assertClassroomAccess,
  waitForRunCompletion,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import type { Route } from './+types/route';

/**
 * Load a GitRepoAssignment by id and confirm it belongs to `classroomId`.
 *
 * SECURITY: the request body is trusted only for the id — the record (and the
 * classroom it belongs to) is derived from the DB. A caller authorized for one
 * classroom must never be able to reach another classroom's submission by
 * posting its id/object. Returns `null` on a missing id, a missing record, or a
 * classroom mismatch so callers can respond with a 404.
 */
async function loadClassroomScopedGitRepoAssignment(id: unknown, classroomId: string) {
  if (typeof id !== 'string' || !id) return null;
  const record = await ClassmojiService.gitRepoAssignment.findById(id);
  if (!record || record.git_repo?.classroom_id !== classroomId) return null;
  return record;
}

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const data = await request.json();

  return namedAction(request, {
    async autograde() {
      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'autograde',
        metadata: { repositoryId: data.repositoryId },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      // Verify the repository the task will act on belongs to this classroom
      // before triggering, and rebuild the payload explicitly — never spread the
      // raw body into the task (which would let a caller target another
      // classroom's repo or override the classroom slug).
      const repositoryId = data.repositoryId;
      const repository =
        typeof repositoryId === 'string' && repositoryId
          ? await ClassmojiService.repository.findById(repositoryId)
          : null;

      if (!repository || repository.classroom_id !== classroom.id) {
        return errorResponse(
          {
            action: 'AUTOGRADE_GIT_REPO_ASSIGNMENT',
            error: 'Repository not found for this classroom.',
          },
          { status: 404 }
        );
      }

      try {
        const run = await tasks.trigger('dispatch_autograde_workflow', {
          repositoryId,
          classroomSlug: classSlug,
        });

        await waitForRunCompletion(run.id);

        return {
          success: 'Autograding workflow pushed to student repos',
          action: 'AUTOGRADE_GIT_REPO_ASSIGNMENT',
        };
      } catch (error: unknown) {
        console.error('dispatch_autograde_workflow failed:', error);
        return {
          action: 'AUTOGRADE_GIT_REPO_ASSIGNMENT',
          error:
            'Autograding failed to provision. Make sure the Classmoji app has the "workflows" permission for this organization, then try again.',
        };
      }
    },

    async addGrade() {
      const { userId, classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'add_grade',
        metadata: { git_repo_assignment_id: data.gitRepoAssignment?.id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const grade = data.grade;
      if (typeof grade !== 'string' || grade.trim().length === 0) {
        return errorResponse(
          { action: ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT, error: 'A grade is required.' },
          { status: 400 }
        );
      }

      // Trust only the id from the body; derive the record, its classroom, and
      // the token recipient (student/team) from the DB.
      const gitRepoAssignment = await loadClassroomScopedGitRepoAssignment(
        data.gitRepoAssignment?.id,
        classroom.id
      );
      if (!gitRepoAssignment) {
        return errorResponse(
          {
            action: ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT,
            error: 'Submission not found for this classroom.',
          },
          { status: 404 }
        );
      }

      await HelperService.addGradeToGitRepoAssignment({
        classroom,
        gitRepoAssignment: { id: gitRepoAssignment.id },
        // The UI always grades as the signed-in user; use the authenticated id
        // rather than a client-supplied graderId.
        graderId: userId,
        grade,
        studentId: gitRepoAssignment.git_repo.student_id ?? undefined,
        teamId: gitRepoAssignment.git_repo.team_id ?? undefined,
      });

      return {
        action: ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT,
        success: 'Added grade successfully!',
      };
    },

    async removeGrade() {
      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'remove_grade',
        metadata: { git_repo_assignment_id: data.gitRepoAssignment?.id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const gitRepoAssignment = await loadClassroomScopedGitRepoAssignment(
        data.gitRepoAssignment?.id,
        classroom.id
      );
      if (!gitRepoAssignment) {
        return errorResponse(
          {
            action: ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT,
            error: 'Submission not found for this classroom.',
          },
          { status: 404 }
        );
      }

      // Load the grade by id and confirm it belongs to the (classroom-verified)
      // submission before deleting it / reversing tokens.
      const gradeId = data.grade?.id;
      if (typeof gradeId !== 'string' || !gradeId) {
        return errorResponse(
          {
            action: ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT,
            error: 'A grade is required.',
          },
          { status: 400 }
        );
      }

      const gradeRecord = await ClassmojiService.assignmentGrade.findById(gradeId);
      if (!gradeRecord || gradeRecord.git_repo_assignment_id !== gitRepoAssignment.id) {
        return errorResponse(
          {
            action: ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT,
            error: 'Grade not found for this submission.',
          },
          { status: 404 }
        );
      }

      await HelperService.removeGradeFromGitRepoAssignment({
        classroom,
        gitRepoAssignment: {
          id: gitRepoAssignment.id,
          studentId: gitRepoAssignment.git_repo.student_id ?? undefined,
          teamId: gitRepoAssignment.git_repo.team_id ?? undefined,
        },
        grade: gradeRecord,
      });

      return {
        action: ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT,
        success: 'Removed grade successfully!',
      };
    },

    async updateLateOverride() {
      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'update_late_override',
        metadata: { git_repo_assignment_id: data.git_repo_assignment_id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const { is_late_override } = data;

      const gitRepoAssignment = await loadClassroomScopedGitRepoAssignment(
        data.git_repo_assignment_id,
        classroom.id
      );
      if (!gitRepoAssignment) {
        return errorResponse(
          {
            action: ActionTypes.UPDATE_LATE_OVERRIDE,
            error: 'Submission not found for this classroom.',
          },
          { status: 404 }
        );
      }

      const message = is_late_override ? 'Added override' : 'Removed override';

      await ClassmojiService.gitRepoAssignment.update(gitRepoAssignment.id, {
        is_late_override: Boolean(is_late_override),
      });

      return {
        action: ActionTypes.UPDATE_LATE_OVERRIDE,
        success: message,
      };
    },

    async updateGradeRelease() {
      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'update_grade_release',
        metadata: { assignment_id: data.assignment_id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const { assignment_id, grades_released } = data;

      // Load the assignment and verify it belongs to this classroom (via its
      // repository) before flipping the release flag.
      const assignment =
        typeof assignment_id === 'string' && assignment_id
          ? await ClassmojiService.assignment.findById(assignment_id)
          : null;

      if (!assignment || assignment.repository?.classroom_id !== classroom.id) {
        return errorResponse(
          {
            action: ActionTypes.UPDATE_GRADE_RELEASE,
            error: 'Assignment not found for this classroom.',
          },
          { status: 404 }
        );
      }

      const message = grades_released
        ? 'Grades released to students'
        : 'Grades hidden from students';

      await ClassmojiService.assignment.update(assignment.id, {
        grades_released: Boolean(grades_released),
      });

      return {
        action: ActionTypes.UPDATE_GRADE_RELEASE,
        success: message,
      };
    },
  });
};
