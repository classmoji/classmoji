import { redirect } from 'react-router';
import { assertClassroomAccess } from '~/utils/helpers';
import { PAGES_FROM_PARAM, pagesFromReferer } from '~/components/features/pages/usePagesFromParam';
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

  // Redirect to apps/pages, saying where the editor was opened from so the
  // pages top bar can bring them back (see usePagesFromParam; the pages app
  // accepts only a page of this classroom).
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  const target = new URL(`${pagesUrl}/${classSlug}/${pageId}`);
  target.searchParams.set(
    PAGES_FROM_PARAM,
    pagesFromReferer(request.url, request.headers.get('referer'), classSlug!)
  );
  return redirect(target.toString());
};

export default function Component() {
  return null;
}
