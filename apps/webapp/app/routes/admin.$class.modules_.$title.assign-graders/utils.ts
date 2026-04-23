import _ from 'lodash';

import Tasks from '@classmoji/tasks';
import { ClassmojiService } from '@classmoji/services';

interface AssignGradersData {
  selectedAssignmentId: string;
  method: 'RANDOM' | string;
  classroomSlug: string;
  templateAssignmentId?: string;
}

interface GraderInfo {
  id?: string;
  login?: string | null;
  studentId?: string | null;
  teamId?: string | null;
  graders?: Array<{ grader: { id: string; login: string | null } }>;
  [key: string]: unknown;
}

export const assignGradersToAssignmentsHandler = async (
  data: AssignGradersData,
  sessionId: string
) => {
  const { selectedAssignmentId, method, classroomSlug } = data;

  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const gitOrganization = classroom!.git_organization;

  const repoAssignments = await ClassmojiService.repositoryAssignment.findByAssignmentId(
    selectedAssignmentId,
    classroomSlug
  );

  const graderLoginList = await getGradersList({
    ...data,
    repoAssignments: repoAssignments as unknown as Record<string, unknown>[],
    classroom: classroom!,
  });

  const taskPayloads = repoAssignments.map((repoAssignment, index) => {
    const { repository } = repoAssignment;

    if (method === 'RANDOM') {
      return {
        payload: {
          repoName: repository.name,
          gitOrganization,
          githubIssueNumber: repoAssignment.provider_issue_number,
          repositoryAssignmentId: repoAssignment.id,
          graderLogin: graderLoginList[index].login!,
          graderId: graderLoginList[index].id!,
        },
        options: { tags: [`session_${sessionId}`] },
      };
    } else {
      const isIndividualRepository = repository.student_id !== null;
      let graderMatch;

      if (isIndividualRepository) {
        graderMatch = graderLoginList.find(grader => grader.studentId === repository.student_id);
      } else {
        graderMatch = graderLoginList.find(grader => grader.teamId === repository.team_id);
      }

      // Skip if no matching grader assignment found in template
      if (!graderMatch || !graderMatch.graders?.length) {
        return [];
      }

      const payloads = graderMatch.graders.map(
        ({ grader }: { grader: { id: string; login: string | null } }) => {
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
        }
      );

      return payloads;
    }
  });

  const flatPayloads = _.flatten(taskPayloads);

  await Tasks.addGraderToRepositoryAssignmentTask.batchTrigger(
    flatPayloads as Parameters<typeof Tasks.addGraderToRepositoryAssignmentTask.batchTrigger>[0]
  );

  const numAssignmentsToAddGradersTo = flatPayloads.length;

  return { numAssignmentsToAddGradersTo };
};

interface GetGradersData extends AssignGradersData {
  repoAssignments: Array<Record<string, unknown>>;
  classroom: { id: string };
}

const getGradersList = async (data: GetGradersData): Promise<GraderInfo[]> => {
  const { method, templateAssignmentId, classroomSlug, repoAssignments, classroom } = data;

  let graderLoginList: GraderInfo[] = [];

  if (method === 'RANDOM') {
    const assistants = _.shuffle(
      await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'ASSISTANT', {
        is_grader: true,
      })
    );

    graderLoginList = (repoAssignments as unknown[]).map((_, index: number) => {
      return assistants[index % assistants.length] as unknown as GraderInfo;
    });
  } else {
    const templateRepoAssignments = await ClassmojiService.repositoryAssignment.findByAssignmentId(
      templateAssignmentId!,
      classroomSlug
    );

    graderLoginList = templateRepoAssignments.map(repoAssignment => ({
      studentId: repoAssignment.repository.student_id,
      teamId: repoAssignment.repository.team_id,
      graders: repoAssignment.graders as unknown as GraderInfo['graders'],
    }));
  }

  return graderLoginList;
};
