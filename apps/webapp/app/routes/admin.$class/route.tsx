import { Outlet } from 'react-router';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * /admin/:class/** is the OWNER namespace, and this loader is what says so.
 *
 * Non-owners have their own prefixes — /teacher and /assistant — and every
 * screen under here that their role can use is served there too. This route
 * used to be a bare <Outlet/> with no loader, so nothing gated the namespace
 * itself and each leaf gated only itself; a screen whose own gate admitted a
 * teacher or an assistant was therefore reachable at /admin as well, which was
 * never the intent.
 *
 * This does NOT make the child actions safe, and it is not meant to: React
 * Router runs a leaf ACTION before any parent loader, so a layout loader can
 * never gate a write beneath it. Every action under here keeps its own gate.
 * This closes the namespace for navigation and for loaders; the leaves close
 * themselves for writes.
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
