import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { SimpleStub } from '~/components/features/stub';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  await assertClassroomAccess({
    request,
    classroomSlug: params.class!,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'SYLLABUS',
    attemptedAction: 'view_syllabus',
  });
  return {};
};

const StudentSyllabus = () => (
  <SimpleStub
    title="Syllabus"
    body="Course overview, grading rubric, policies — edited by the instructor in the Notion-style page editor."
  />
);

export default StudentSyllabus;
