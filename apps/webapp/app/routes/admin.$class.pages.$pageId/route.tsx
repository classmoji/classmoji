import { redirect } from 'react-router';
import { assertClassroomAccess } from '~/utils/helpers';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, pageId } = params;

  // Verify admin/teacher access
  await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
  });

  // Redirect to apps/pages
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  return redirect(`${pagesUrl}/${classSlug}/${pageId}`);
};

export default function Component() {
  return null;
}
