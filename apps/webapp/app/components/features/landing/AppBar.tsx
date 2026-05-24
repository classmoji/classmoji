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

const iconBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  display: 'grid',
  placeItems: 'center',
  color: 'var(--ink-2)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

export function AppBar({ user, notifications, unreadCount, membershipRoles }: AppBarProps) {
  const initials = getInitials(user?.name, user?.login);
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 24,
        padding: '0 28px',
        height: 60,
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg-1)',
      }}
    >
      {/* Left group: brand + primary nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <Logo variant="full" size={24} theme="current" />

      </div>

      {/* Right group: help / bell / user */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          title="Help & docs"
          style={iconBtn}
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '3px 10px 3px 3px',
              borderRadius: 24,
              border: '1px solid var(--line)',
              background: 'var(--bg-1)',
              fontSize: 13,
              cursor: 'pointer',
              marginLeft: 4,
            }}
          >
            {user?.avatar_url ? (
              <img
                src={user.avatar_url}
                alt={user?.name ?? user?.login ?? 'User'}
                style={{ width: 28, height: 28, borderRadius: '50%' }}
              />
            ) : (
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, oklch(80% 0.1 310), oklch(60% 0.18 310))',
                  color: 'white',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {initials}
              </span>
            )}
            <IconChevron size={13} />
          </button>
        </ProfileDropdown>
      </div>
    </header>
  );
}
