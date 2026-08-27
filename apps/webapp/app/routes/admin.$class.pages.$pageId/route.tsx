import { redirect } from 'react-router';
import { assertClassroomAccess } from '~/utils/helpers';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, pageId } = params;

  // Verify admin/teacher access.
  //
  // Named: with no resourceType this fell back to 'CLASSROOM_ACCESS', the
  // catch-all that says nothing about what was refused. This loader is the
  // hand-off into the pages editor and is served under both /admin and
  // /teacher (which re-exports it), so 'PAGES' — the vocabulary the pages list,
  // its mutations and the MCP page tools all already use — is right for both.
  await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'open_page_editor',
  });

  // Redirect to apps/pages
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  return redirect(`${pagesUrl}/${classSlug}/${pageId}`);
};

export default function Component() {
  return null;
}
