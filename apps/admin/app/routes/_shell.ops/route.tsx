import { NavLink, Outlet } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

/** Ops: platform switches and the record of what admins did. */
export async function loader({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  return null;
}

const SECTIONS = [
  { to: '/ops/delivery', label: 'Content delivery' },
  { to: '/ops/activity', label: 'Activity log' },
  { to: '/ops/gitlab', label: 'Gitlab' },
];

export default function Ops() {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Ops</h1>
        <nav
          className="inline-flex rounded-lg border border-line p-0.5 text-sm bg-panel"
          aria-label="Ops sections"
        >
          {SECTIONS.map(s => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1 ${isActive ? 'bg-nav-hover text-ink-0 font-medium' : 'text-ink-2 hover:text-ink-0'}`
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </>
  );
}
