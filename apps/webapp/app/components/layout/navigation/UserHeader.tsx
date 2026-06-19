import { Link, useRouteLoaderData } from 'react-router';
import { useUser } from '~/hooks';
import { Logo, IconDocs, IconChevron } from '@classmoji/ui-components';
import ProfileDropdown from '~/components/features/profile/ProfileDropdown';
import {
  NotificationBell,
  type BellNotification,
  type NotificationRole,
} from '~/components/features/notifications';
import { getInitials } from '~/utils/hue';

interface UserLayoutData {
  notifications: BellNotification[];
  unreadCount: number;
  membershipRoles: Record<string, NotificationRole[]>;
}

const UserHeader = () => {
  const { user } = useUser();
  const initials = getInitials(user?.name, user?.login);
  const layoutData = useRouteLoaderData('routes/_user') as UserLayoutData | undefined;

  return (
    <div className="sticky top-0 z-50 pt-3 sm:pt-7 pb-4">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-8">
      <div className="flex items-center justify-between h-[52px] px-3 sm:px-6 rounded-2xl bg-panel/80 backdrop-blur-xl ring-1 ring-line shadow-sm">
        <Link to="/select-organization" className="flex items-center gap-2 no-underline text-[#0d0d10] dark:text-white">
          <Logo variant="full" size={28} theme="current" />
        </Link>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Help & docs"
            className="w-9 h-9 rounded-lg grid place-items-center text-ink-3 hover:bg-nav-hover transition-colors cursor-pointer border-none bg-transparent"
            onClick={() =>
              window.open('https://classmoji.io/docs', '_blank', 'noopener,noreferrer')
            }
          >
            <IconDocs size={16} />
          </button>
          <span data-onboarding="bell" className="inline-flex">
            <NotificationBell
              initialItems={layoutData?.notifications ?? []}
              initialUnreadCount={layoutData?.unreadCount ?? 0}
              membershipRoles={layoutData?.membershipRoles ?? {}}
            />
          </span>

          <ProfileDropdown>
            <button
              type="button"
              data-onboarding="profile"
              className="flex items-center gap-2 py-0.5 pl-0.5 pr-2.5 rounded-full border border-line bg-panel hover:bg-panel-hover cursor-pointer ml-1 transition-colors text-sm"
            >
              {user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt={user?.name ?? user?.login ?? 'User'}
                  className="w-7 h-7 rounded-full"
                />
              ) : (
                <span
                  className="w-7 h-7 rounded-full grid place-items-center text-white text-xs font-semibold"
                  style={{ background: 'linear-gradient(135deg, oklch(80% 0.1 310), oklch(60% 0.18 310))' }}
                >
                  {initials}
                </span>
              )}
              <IconChevron size={13} />
            </button>
          </ProfileDropdown>
        </div>
      </div>
      </div>
    </div>
  );
};

export default UserHeader;
