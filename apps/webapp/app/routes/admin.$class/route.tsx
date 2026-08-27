import { Outlet } from 'react-router';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * /admin/:class/** is the OWNER namespace for NAVIGATION, and this loader is
 * what makes that true.
 *
 * Non-owners have their own prefixes — /teacher and /assistant — and every
 * screen under here that their role can use is served there too. This route
 * used to be a bare <Outlet/> with no loader, so nothing gated the namespace
 * itself and each leaf gated only itself; a screen whose own gate admitted a
 * teacher or an assistant was therefore reachable at /admin as well, which was
 * never the intent.
 *
 * READ THE SCOPE PRECISELY — this is NOT a mutation boundary, and treating it
 * as one would be a mistake:
 *
 *   - It closes the namespace to non-owner BROWSING, and to loaders.
 *   - It does NOT close it to writes. React Router matches only the ACTION
 *     route for a submission and revalidates loaders afterwards, so a POST
 *     straight to /admin/:class/<leaf> runs the leaf action FIRST; this
 *     loader's 403 arrives after the write has already happened.
 *
 * That is not a hole today, because the leaf actions beneath here carry their
 * own gates and legitimately admit the roles that reach them — the identical
 * actions are exported under those roles' own prefixes, so posting here grants
 * no capability that posting there would not. It stays that way only as long
 * as every action under here keeps gating itself. This loader can never do it
 * for them.
 *
 * requireClassroomAdmin throws a 403 Response, which the root ErrorBoundary
 * renders as an error page. That is deliberately different from the parent
 * /admin route, which catches and degrades so the shell still renders at
 * /admin with no classroom selected.
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  await requireClassroomAdmin(request, params.class!, {
    resourceType: 'ADMIN_NAMESPACE',
    action: 'enter_admin_namespace',
  });

  return null;
};

const AdminOrg = () => {
  return <Outlet />;
};

export default AdminOrg;
