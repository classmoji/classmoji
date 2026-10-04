import { Link, NavLink, Outlet, useLoaderData, useLocation } from 'react-router';
import { getAuthSession, PLATFORM_ADMIN_USER_IDS } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import { FeedbackAvatar } from '~/components/features/feedback/FeedbackAvatar';
import { signInHref } from '~/components/features/feedback/feedback';
import type { Route } from './+types/route';

/**
 * The public feedback board's shell. Readable signed out (the root loader lets
 * /feedback through); the viewer, when there is one, is passed down so the
 * pages know who can vote and who is a platform admin.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request).catch(() => null);
  const userId = authData?.userId ?? null;
  const viewer = userId
    ? await getPrisma().user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, image: true },
      })
    : null;
  return { viewer, isAdmin: viewer ? PLATFORM_ADMIN_USER_IDS.includes(viewer.id) : false };
};

export const meta = () => [
  { title: 'Feedback - Classmoji' },
  {
    name: 'description',
    content: 'Request features, vote on ideas, and see what Classmoji is building next.',
  },
];

const TABS = [
  { label: 'Feedback', to: '/feedback', end: true },
  { label: 'Roadmap', to: '/feedback/roadmap', end: false },
];

export default function FeedbackLayout() {
  const { viewer } = useLoaderData<typeof loader>();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-[#fafaf9] dark:bg-neutral-950">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex h-16 max-w-[1680px] px-6 lg:px-10 items-center justify-between gap-6">
          <div className="flex h-full items-center gap-5">
            <a
              href="https://classmoji.io"
              className="flex shrink-0 items-center gap-2 no-underline"
              aria-label="Classmoji home"
            >
              <span className="text-2xl leading-none" aria-hidden>
                🍎
              </span>
              <span className="text-xl font-extrabold tracking-tight text-ink-0">classmoji</span>
            </a>
            <span className="h-6 w-px bg-line" aria-hidden />
            {/* Tabs sit in the header row, underlined along its bottom edge. */}
            <nav aria-label="Feedback" className="flex h-full gap-1">
              {TABS.map(tab => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) =>
                    `-mb-px flex items-center border-b-2 px-3 text-[0.9375rem] font-medium no-underline transition-colors duration-150 ${
                      isActive
                        ? 'border-ink-0 text-ink-0!'
                        : 'border-transparent text-ink-3! hover:text-ink-0!'
                    }`
                  }
                >
                  {tab.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {viewer ? (
              <Link
                to="/select-organization"
                className="flex items-center gap-2 rounded-lg px-2 py-1 no-underline hover:bg-panel-hover"
              >
                <FeedbackAvatar name={viewer.name ?? ''} image={viewer.image} size={28} />
                <span className="hidden text-sm font-medium text-ink-1 sm:inline">My classes</span>
              </Link>
            ) : (
              <Link
                to={signInHref(`${location.pathname}${location.search}`)}
                className="inline-flex h-9 items-center rounded-lg bg-accent! px-4 text-sm font-semibold text-white! no-underline transition-colors duration-150 hover:bg-accent-hover!"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
