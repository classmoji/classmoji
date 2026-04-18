import {
  Logo,
  IconSearch,
  IconBell,
  IconSupport,
  IconChevron,
} from '@classmoji/ui-components';
import ProfileDropdown from '~/components/features/profile/ProfileDropdown';
import { getInitials } from '~/utils/hue';

interface AppBarProps {
  user: { name?: string | null; login?: string | null; avatar_url?: string | null } | null;
}

export function AppBar({ user }: AppBarProps) {
  const initials = getInitials(user?.name, user?.login);
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 20px',
        height: 48,
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg-1)',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontWeight: 600,
          fontSize: 14,
          letterSpacing: '-0.01em',
        }}
      >
        <Logo size={22} variant="icon" />
        classmoji
      </span>

      <nav style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
        <button
          type="button"
          style={{
            padding: '4px 10px',
            borderRadius: 5,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--ink-0)',
            background: 'transparent',
            cursor: 'pointer',
            border: 'none',
          }}
        >
          Classes
        </button>
        <button
          type="button"
          style={{
            padding: '4px 10px',
            borderRadius: 5,
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--ink-2)',
            background: 'transparent',
            cursor: 'pointer',
            border: 'none',
          }}
        >
          Inbox
        </button>
        <button
          type="button"
          style={{
            padding: '4px 10px',
            borderRadius: 5,
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--ink-2)',
            background: 'transparent',
            cursor: 'pointer',
            border: 'none',
          }}
        >
          Explore
        </button>
      </nav>

      <div
        style={{
          flex: 1,
          maxWidth: 440,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 30,
          padding: '0 10px',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
          background: 'var(--bg-0)',
          color: 'var(--ink-3)',
          fontSize: 12.5,
        }}
      >
        <IconSearch size={14} />
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

      <button
        type="button"
        title="What's new"
        style={{
          width: 30,
          height: 30,
          borderRadius: 6,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-2)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <IconSupport size={14} />
      </button>
      <button
        type="button"
        title="Notifications"
        style={{
          width: 30,
          height: 30,
          borderRadius: 6,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-2)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          position: 'relative',
        }}
      >
        <IconBell size={14} />
        <span
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 6,
            height: 6,
            background: 'var(--violet)',
            borderRadius: '50%',
          }}
        />
      </button>

      <ProfileDropdown>
        <button
          type="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 6px 2px 2px',
            borderRadius: 20,
            border: '1px solid var(--line)',
            background: 'var(--bg-1)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {user?.avatar_url ? (
            <img
              src={user.avatar_url}
              alt={user?.name ?? user?.login ?? 'User'}
              style={{ width: 22, height: 22, borderRadius: '50%' }}
            />
          ) : (
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background:
                  'linear-gradient(135deg, oklch(80% 0.1 310), oklch(60% 0.18 310))',
                color: 'white',
                display: 'grid',
                placeItems: 'center',
                fontSize: 10,
                fontWeight: 600,
              }}
            >
              {initials}
            </span>
          )}
          <IconChevron size={12} />
        </button>
      </ProfileDropdown>
    </header>
  );
}
