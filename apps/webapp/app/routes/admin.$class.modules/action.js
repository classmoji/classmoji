import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { publishAssignment, syncAssignment } from './helpers';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom, userId } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'manage_modules',
  });

  const data = await request.json();
  const assignmentId = data.assignment_id;

  return namedAction(request, {
    async delete() {
      await ClassmojiService.module.deleteById(assignmentId);

      return {
        success: 'Module deleted',
        action: ActionTypes.DELETE_ASSIGNMENT,
      };
    },

    async publish() {
      return publishAssignment(classSlug, assignmentId, userId);
    },

    async sync() {
      const res = await syncAssignment(classSlug, assignmentId, userId);
      const {
        triggerSession: { numReposToCreate, numIssuesToCreate },
      } = res;

      if (numReposToCreate + numIssuesToCreate == 0)
        return {
          info: 'No missing repo or issue',
        };

      return res;
    },

    async updateAssignment() {
      const { weight } = data;

      const result = await ClassmojiService.module.update(assignmentId, { weight });

      return result;
    },

    async findUnenrolledStudents() {
      const students = await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT');
      const student_ids = students.map(({ id }) => id);
      const repositories = await ClassmojiService.repository.findMany({
        classroom_id: classroom.id,
      });

      const repositoriesToRemove = [];

      const unenrolledStudents = new Map();

      repositories.forEach(repo => {
        if (!repo.student) return;
        if (!student_ids.includes(repo.student.id)) {
          unenrolledStudents.set(repo.student.id, repo.student);
          repositoriesToRemove.push(repo.name);
        }
      });

      return {
        success:
          unenrolledStudents.size > 0
            ? 'Unenrolled students found'
            : 'No unenrolled students found',
        students: Array.from(unenrolledStudents.values()),
        repositories: repositoriesToRemove,
      };
    },
  });
};
