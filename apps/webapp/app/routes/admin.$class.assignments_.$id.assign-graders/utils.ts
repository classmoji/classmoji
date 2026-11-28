import { ClassmojiService } from '@classmoji/services';
import type { AssignGradersMethod } from '@classmoji/services';
import type { AuditActor } from '@classmoji/services/audit';

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
  sessionId: string,
  /** Who the service records the bulk assignment for (it writes the row). */
  actor: AuditActor
) => {
  return ClassmojiService.gitRepoAssignmentGrader.assignGradersToAssignment({
    classroomId: data.classroomId,
    assignmentId: data.selectedAssignmentId,
    method: data.method,
    templateAssignmentId: data.templateAssignmentId,
    sessionId,
    actor,
  });
};
