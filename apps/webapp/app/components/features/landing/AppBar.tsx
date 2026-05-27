import { Link } from 'react-router';
import { Logo, IconDocs, IconChevron } from '@classmoji/ui-components';
import ProfileDropdown from '~/components/features/profile/ProfileDropdown';
import { getInitials } from '~/utils/hue';
import {
  NotificationBell,
  type BellNotification,
  type NotificationRole,
} from '~/components/features/notifications';

interface AppBarProps {
  user: { name?: string | null; login?: string | null; avatar_url?: string | null } | null;
  notifications?: BellNotification[];
  unreadCount?: number;
  membershipRoles?: Record<string, NotificationRole[]>;
}

export function AppBar({ user, notifications, unreadCount, membershipRoles }: AppBarProps) {
  const initials = getInitials(user?.name, user?.login);
  return (
    <div className="sticky top-0 z-10 pt-3 max-w-[1280px] mx-auto px-8">
    <header className="flex items-center justify-between h-[52px] px-6 rounded-2xl bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl ring-1 ring-line shadow-sm">
      <Link to="/select-organization" className="flex items-center gap-2 text-[#0d0d10] dark:text-white">
        <Logo variant="full" size={24} theme="current" />
      </Link>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          title="Help & docs"
          aria-label="Help and docs"
          className="w-9 h-9 rounded-lg grid place-items-center text-ink-3 hover:bg-nav-hover transition-colors cursor-pointer border-none bg-transparent"
          onClick={() =>
            window.open('https://classmoji.io/docs', '_blank', 'noopener,noreferrer')
          }
        >
          <IconDocs size={16} />
        </button>
        <NotificationBell
          initialItems={notifications ?? []}
          initialUnreadCount={unreadCount ?? 0}
          membershipRoles={membershipRoles ?? {}}
        />

        <ProfileDropdown>
          <button
            type="button"
            aria-label="Open profile menu"
            className="flex items-center gap-2 py-0.5 pl-0.5 pr-2.5 rounded-full border border-line bg-panel hover:bg-nav-hover cursor-pointer ml-1 transition-colors text-sm"
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
    </header>
    </div>
  );
}
