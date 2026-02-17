import { redirect } from 'react-router';
import { assertClassroomAccess } from '~/utils/helpers';

export const loader = async ({ params, request }) => {
  const { class: classSlug, pageId } = params;

  // Verify admin/teacher access
  await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
  });

  // Redirect to apps/pages
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  return redirect(`${pagesUrl}/${classSlug}/${pageId}`);
};

export default function Component() {
  return null;
}
