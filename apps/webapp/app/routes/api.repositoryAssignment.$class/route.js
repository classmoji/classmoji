import { namedAction } from 'remix-utils/named-action';

import { tasks } from '@trigger.dev/sdk';

import { ClassmojiService, HelperService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { assertClassroomAccess, waitForRunCompletion } from '~/utils/helpers';

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;
  const data = await request.json();

  return namedAction(request, {
    async autograde() {
      const { userId, classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'REPOSITORY_ASSIGNMENT',
        attemptedAction: 'autograde',
        metadata: { workflowName: data.workflowName },
      });

      try {
        const run = await tasks.trigger('dispatch_autograde_workflow', {
          ...data,
        });

        await waitForRunCompletion(run.id);

        return {
          success: 'Autograde workflow created',
          action: 'AUTOGRADE_REPOSITORY_ASSIGNMENT',
        };
      } catch (error) {
        console.error('dispatch_autograde_workflow failed:', error);
        return {
          action: 'AUTOGRADE_REPOSITORY_ASSIGNMENT',
          error: 'Failed to start autograde workflow. Please try again.',
        };
      }
    },

    async addGrade() {
      const { userId, classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'REPOSITORY_ASSIGNMENT',
        attemptedAction: 'add_grade',
        metadata: { assignment_id: data.repositoryAssignment?.assignment_id },
      });

      const { repoName, repositoryAssignment, graderId, grade, studentId, teamId } = data;

      await HelperService.addGradeToRepositoryAssignment({
        classroom,
        repoName,
        repositoryAssignment,
        graderId,
        grade,
        studentId,
        teamId,
      });

      return {
        action: ActionTypes.ADD_GRADE_TO_REPOSITORY_ASSIGNMENT,
        success: 'Added grade successfully!',
      };
    },

    async removeGrade() {
      const { userId, classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'REPOSITORY_ASSIGNMENT',
        attemptedAction: 'remove_grade',
        metadata: { assignment_id: data.repositoryAssignment?.assignment_id },
      });

      const { grade, repositoryAssignment, repoName } = data;

      await HelperService.removeGradeFromRepositoryAssignment({
        classroom,
        repoName,
        repositoryAssignment,
        grade,
      });

      return {
        action: ActionTypes.REMOVE_GRADE_FROM_REPOSITORY_ASSIGNMENT,
        success: 'Removed grade successfully!',
      };
    },

    async updateLateOverride() {
      const { userId, classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'REPOSITORY_ASSIGNMENT',
        attemptedAction: 'update_late_override',
        metadata: { repository_assignment_id: data.repository_assignment_id },
      });

      const { repository_assignment_id, is_late_override } = data;
      const message = is_late_override ? 'Added override' : 'Removed override';

      await ClassmojiService.repositoryAssignment.update(repository_assignment_id, {
        is_late_override,
      });

      return {
        action: ActionTypes.UPDATE_LATE_OVERRIDE,
        success: message,
      };
    },

    async updateGradeRelease() {
      const { classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'REPOSITORY_ASSIGNMENT',
        attemptedAction: 'update_grade_release',
        metadata: { assignment_id: data.assignment_id },
      });

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
