import type { Route } from './+types/route';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { SimpleStub } from '~/components/features/stub';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  await requireClassroomAdmin(request, params.class!, {
    resourceType: 'SYLLABUS',
    action: 'view_syllabus',
  });
  return {};
};

const AdminSyllabus = () => (
  <SimpleStub
    title="Syllabus"
    body="Course overview, grading rubric, policies — edited by the instructor in the Notion-style page editor."
  />
);

export default AdminSyllabus;
