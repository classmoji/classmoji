import { redirect } from 'react-router';
import { assertClassroomAccess, assertProTier } from '~/utils/helpers';
import type { Route } from './+types/route';

/**
 * Forms DEEP LINKS: a gate and a redirect into apps/pages, exactly as
 * `admin.$class.pages.$pageId` hands off to the page editor.
 *
 * The list itself is no longer here — it is a real webapp screen at
 * `admin.$class.forms`. What still crosses to the pages app is everything
 * below it: `/forms/new` (the new-form drawer), `/forms/:slug/edit` (the
 * builder), and `/forms/:slug/responses`. Those are the links the webapp list
 * points at, and they are also the shape of any bookmark saved while the whole
 * subtree lived over there, so they keep resolving.
 *
 * The trailing underscore in the route id (`forms_.$`) is load-bearing: without
 * it this splat would nest INSIDE `admin.$class.forms` and render in its
 * Outlet — the list, with a redirect route mounted underneath it — instead of
 * matching `/forms/*` on its own and redirecting.
 *
 * The gate is real, not decorative. `isProTier` on the nav entry only hides the
 * item; this loader is what refuses a free-tier classroom, and the pages-side
 * `assertFormAdmin` refuses again on arrival — a hand-typed pages URL never
 * passes through here at all.
 */

/**
 * Rebuild the splat as a relative path, dropping anything that could climb out
 * of the forms subtree. The splat is user-controlled URL text: `..` segments
 * would let `/admin/cs52/forms/../../evil` land outside `/{class}/forms`, and a
 * leading empty segment would produce `//host` — a protocol-relative URL, i.e.
 * an open redirect to another origin.
 */
export function sanitizeFormsSplat(splat: string | undefined): string {
  return (splat ?? '')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Named resourceType rather than the 'CLASSROOM_ACCESS' catch-all, so a
  // denial in the audit log says what was refused. 'FORMS' is the vocabulary
  // the pages-side gate and (later) the MCP form tools use too.
  await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'FORMS',
    attemptedAction: 'open_forms',
  });

  // Pro is enforced server-side, after access: a free-tier classroom gets a 403
  // here instead of a redirect into a surface that would only refuse it again.
  await assertProTier(classSlug);

  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  const rest = sanitizeFormsSplat(params['*']);
  return redirect(`${pagesUrl}/${classSlug}/forms${rest ? `/${rest}` : ''}`);
};

export default function Component() {
  return null;
}
