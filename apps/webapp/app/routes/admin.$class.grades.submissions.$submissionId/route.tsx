import { useOutletContext } from 'react-router';

import { requireClassroomStaff } from '~/utils/routeAuth.server';
import { addClassroomAuditLog } from '~/utils/helpers';
import { canMutate } from '~/utils/mutationRefusal.server';
import type { SubmissionPanelOutletContext } from '../admin.$class.grades/gradingWalk';
import { loadSubmissionPanel } from './panel.server';
import SubmissionPanel from './SubmissionPanel';
import type { Route } from './+types/route';

/**
 * The gradebook's submission panel: one submission beside the gradebook,
 * graded in place. A child of the grades route, so opening it or walking to
 * the next submission is a path change only and the gradebook's own loader
 * does not run again. Served under /admin and (re-exported) /teacher.
 *
 * No action: grading posts to `/api/gitRepoAssignment` and resolving a
 * regrade request to `/api/operation?action=updateRegradeRequest`, each with
 * its own gate and audit row.
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  // OWNER and TEACHER, the gradebook's own gate.
  const { userId, classroom, membership } = await requireClassroomStaff(request, params.class!, {
    resourceType: 'GRADES',
    action: 'view_submission_panel',
  });

  // The id comes from the URL: it is matched against the gated classroom in
  // the query, and anything else reads as not found.
  const panel = await loadSubmissionPanel({
    classroomId: classroom.id,
    provider: classroom.git_organization?.provider,
    submissionId: params.submissionId!,
  });
  if (!panel) {
    throw new Response('Submission not found', { status: 404 });
  }

  // A staff read of a student's (or team's) submission.
  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership?.role,
    action: 'VIEW',
    resourceType: 'GIT_REPO_ASSIGNMENT',
    resourceId: panel.submission.id,
    // Whose work was read, as the quiz-attempt drawer records it.
    metadata: {
      tool: 'web:grades.submission_panel',
      assignment_id: panel.assignment.id,
      ...(panel.submission.student_id ? { student_id: panel.submission.student_id } : {}),
      ...(panel.submission.team_id ? { team_id: panel.submission.team_id } : {}),
    },
  });

  return {
    ...panel,
    // Grade and resolve controls show only where the classroom takes changes.
    canMutate: canMutate(classroom, membership?.role),
  };
};

const SubmissionPanelRoute = ({ loaderData }: Route.ComponentProps) => {
  const context = useOutletContext<SubmissionPanelOutletContext | undefined>();
  if (!context) return null;
  return <SubmissionPanel data={loaderData} context={context} />;
};

export default SubmissionPanelRoute;
