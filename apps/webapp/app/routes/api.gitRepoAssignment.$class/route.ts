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

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const data = await request.json();

  return namedAction(request, {
    async autograde() {
      const {
        userId: _userId,
        classroom,
        membership,
      } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'autograde',
        metadata: { workflowName: data.workflowName },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      try {
        const run = await tasks.trigger('dispatch_autograde_workflow', {
          ...data,
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
      const {
        userId: _userId,
        classroom,
        membership,
      } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'add_grade',
        metadata: { assignment_id: data.gitRepoAssignment?.assignment_id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const { gitRepoAssignment, graderId, grade, studentId, teamId } = data;

      await HelperService.addGradeToGitRepoAssignment({
        classroom,
        gitRepoAssignment,
        graderId,
        grade,
        studentId,
        teamId,
      });

      return {
        action: ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT,
        success: 'Added grade successfully!',
      };
    },

    async removeGrade() {
      const {
        userId: _userId2,
        classroom,
        membership,
      } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'remove_grade',
        metadata: { assignment_id: data.gitRepoAssignment?.assignment_id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const { grade, gitRepoAssignment } = data;

      await HelperService.removeGradeFromGitRepoAssignment({
        classroom,
        gitRepoAssignment,
        grade,
      });

      return {
        action: ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT,
        success: 'Removed grade successfully!',
      };
    },

    async updateLateOverride() {
      const {
        userId: _userId3,
        classroom,
        membership,
      } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'GIT_REPO_ASSIGNMENT',
        attemptedAction: 'update_late_override',
        metadata: { git_repo_assignment_id: data.git_repo_assignment_id },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const { git_repo_assignment_id, is_late_override } = data;
      const message = is_late_override ? 'Added override' : 'Removed override';

      await ClassmojiService.gitRepoAssignment.update(git_repo_assignment_id, {
        is_late_override,
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
      const message = grades_released
        ? 'Grades released to students'
        : 'Grades hidden from students';

      await ClassmojiService.assignment.update(assignment_id, {
        grades_released,
      });

      return {
        action: ActionTypes.UPDATE_GRADE_RELEASE,
        success: message,
      };
    },
  });
};
