import type { Route } from './+types/route';
import { requireStudentAccess } from '~/utils/helpers';
import { SimpleStub } from '~/components/features/stub';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  await requireStudentAccess(request, params.class!, {
    resourceType: 'STUDENT_TASKS',
    action: 'view_tasks',
  });
  return {};
};

const StudentTasks = () => (
  <SimpleStub
    title="Tasks"
    body="Everything due, in one list. Open a specific item from the dashboard to see it."
  />
);

export default StudentTasks;
