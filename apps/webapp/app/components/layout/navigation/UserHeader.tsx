import { Link } from 'react-router';
import { useUser } from '~/hooks';
import { Logo, IconDocs, IconChevron } from '@classmoji/ui-components';
import ProfileDropdown from '~/components/features/profile/ProfileDropdown';
import { NotificationBell } from '~/components/features/notifications';
import { getInitials } from '~/utils/hue';

const UserHeader = () => {
  const { user } = useUser();
  const initials = getInitials(user?.name, user?.login);

  return (
    <div className="sticky top-0 z-50 pt-7 pb-4 bg-gradient-to-b from-[#EDEDED] from-70% to-transparent dark:from-[#1d1d1d]">
      <div className="max-w-[1280px] mx-auto px-8">
      <div className="flex items-center justify-between h-[52px] px-6 rounded-2xl bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl ring-1 ring-stone-200 dark:ring-neutral-800 shadow-sm">
        <Link to="/select-organization" className="flex items-center gap-2 no-underline !text-[#0d0d10] dark:!text-white">
          <Logo variant="full" size={24} theme="current" />
        </Link>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Help & docs"
            className="w-9 h-9 rounded-lg grid place-items-center text-gray-500 dark:text-gray-400 hover:bg-stone-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer border-none bg-transparent"
            onClick={() =>
              window.open('https://classmoji.io/docs', '_blank', 'noopener,noreferrer')
            }
          >
            <IconDocs size={16} />
          </button>
          <NotificationBell
            initialItems={[]}
            initialUnreadCount={0}
            membershipRoles={{}}
          />

          <ProfileDropdown>
            <button
              type="button"
              className="flex items-center gap-2 py-0.5 pl-0.5 pr-2.5 rounded-full border border-stone-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-stone-50 dark:hover:bg-neutral-800 cursor-pointer ml-1 transition-colors text-[13px]"
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
