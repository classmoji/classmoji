import { ClassmojiService } from '@classmoji/services';
import type { AssignGradersMethod } from '@classmoji/services';

interface AssignGradersData {
  selectedAssignmentId: string;
  method: AssignGradersMethod;
  classroomId: string;
  templateAssignmentId?: string;
}

/**
 * Thin wrapper over ClassmojiService.gitRepoAssignmentGrader.assignGradersToAssignment
 * — the RANDOM/EXISTING selection and the task fan-out live in the service so the
 * web action and the MCP tool take one path. `sessionId` tags the runs for this
 * route's progress stream.
 */
export const assignGradersToAssignmentsHandler = async (
  data: AssignGradersData,
  sessionId: string
) => {
  return ClassmojiService.gitRepoAssignmentGrader.assignGradersToAssignment({
    classroomId: data.classroomId,
    assignmentId: data.selectedAssignmentId,
    method: data.method,
    templateAssignmentId: data.templateAssignmentId,
    sessionId,
  });
};
