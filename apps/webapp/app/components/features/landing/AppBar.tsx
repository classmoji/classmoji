import { Logo, IconSearch, IconSupport, IconChevron } from '@classmoji/ui-components';
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

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  borderRadius: 6,
  fontSize: 13.5,
  fontWeight: active ? 600 : 500,
  color: active ? 'var(--ink-0)' : 'var(--ink-2)',
  background: 'transparent',
  cursor: 'pointer',
  border: 'none',
});

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
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        columnGap: 24,
        padding: '0 28px',
        height: 60,
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg-1)',
      }}
    >
      {/* Left group: brand + primary nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <Logo variant="full" size={24} theme="current" />

        <nav style={{ display: 'flex', gap: 2 }}>
          <button type="button" style={tabBtn(true)}>
            Classes
          </button>
          <button type="button" style={tabBtn(false)}>
            Inbox
          </button>
          <button type="button" style={tabBtn(false)}>
            Explore
          </button>
        </nav>
      </div>

      {/* Middle: search pill, centered in remaining space with a cap */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div
          style={{
            width: '100%',
            maxWidth: 520,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: 36,
            padding: '0 12px',
            border: '1px solid var(--line-2)',
            borderRadius: 8,
            background: 'var(--bg-0)',
            color: 'var(--ink-3)',
            fontSize: 13.5,
          }}
        >
          <IconSearch size={16} />
          <span>Search classes, assignments, students…</span>
          <kbd
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'var(--bg-3)',
              color: 'var(--ink-2)',
              border: '1px solid var(--line)',
            }}
          >
            ⌘K
          </kbd>
        </div>
      </div>

      {/* Right group: help / bell / user */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" title="What's new" style={iconBtn}>
          <IconSupport size={16} />
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
