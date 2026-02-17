import _ from 'lodash';

import Tasks from '@classmoji/tasks';
import { ClassmojiService } from '@classmoji/services';

export const assignGradersToAssignmentsHandler = async (data, sessionId) => {
  const { selectedAssignmentId, method, classroomSlug } = data;

  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const gitOrganization = classroom.git_organization;

  const repoAssignments = await ClassmojiService.repositoryAssignment.findByAssignmentId(
    selectedAssignmentId,
    classroomSlug
  );

  const graderLoginList = await getGradersList({ ...data, repoAssignments, classroom });

  let taskPayloads = repoAssignments.map((repoAssignment, index) => {
    const { repository } = repoAssignment;

    if (method === 'RANDOM') {
      return {
        payload: {
          repoName: repository.name,
          gitOrganization,
          githubIssueNumber: repoAssignment.provider_issue_number,
          repositoryAssignmentId: repoAssignment.id,
          graderLogin: graderLoginList[index].login,
          graderId: graderLoginList[index].id,
        },
        options: { tags: [`session_${sessionId}`] },
      };
    } else {
      const isIndividualRepository = repository.student_id !== null;
      let graderMatch;

      if (isIndividualRepository) {
        graderMatch = graderLoginList.find(
          grader => grader.studentId === repository.student_id
        );
      } else {
        graderMatch = graderLoginList.find(grader => grader.teamId === repository.team_id);
      }

      // Skip if no matching grader assignment found in template
      if (!graderMatch || !graderMatch.graders?.length) {
        return [];
      }

      const payloads = graderMatch.graders.map(({ grader }) => {
        return {
          payload: {
            repoName: repository.name,
            gitOrganization,
            githubIssueNumber: repoAssignment.provider_issue_number,
            repositoryAssignmentId: repoAssignment.id,
            graderLogin: grader.login,
            graderId: grader.id,
          },
          options: { tags: [`session_${sessionId}`] },
        };
      });

      return payloads;
    }
  });

  taskPayloads = _.flatten(taskPayloads);

  await Tasks.addGraderToRepositoryAssignmentTask.batchTrigger(taskPayloads);

  const numAssignmentsToAddGradersTo = taskPayloads.length;

  return { numAssignmentsToAddGradersTo };
};

const getGradersList = async data => {
  const { method, templateAssignmentId, classroomSlug, repoAssignments, classroom } = data;

  let graderLoginList = [];

  if (method === 'RANDOM') {
    const assistants = _.shuffle(
      await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'ASSISTANT', {
        is_grader: true,
      })
    );

    graderLoginList = repoAssignments.map((_, index) => {
      return assistants[index % assistants.length];
    });
  } else {
    const templateRepoAssignments = await ClassmojiService.repositoryAssignment.findByAssignmentId(
      templateAssignmentId,
      classroomSlug
    );

    graderLoginList = templateRepoAssignments.map(repoAssignment => {
      return {
        studentId: repoAssignment.repository.student_id,
        teamId: repoAssignment.repository.team_id,
        graders: repoAssignment.graders,
      };
    });
  }

  return graderLoginList;
};
