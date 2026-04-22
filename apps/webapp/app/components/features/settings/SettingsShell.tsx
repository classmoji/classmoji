import { Link, useLocation, useParams } from 'react-router';
import type { ReactNode } from 'react';

export interface SettingsTab {
  key: string;
  label: string;
  pro?: boolean;
  danger?: boolean;
}

interface SettingsShellProps {
  title?: string;
  tabs: SettingsTab[];
  children: ReactNode;
}

export function SettingsShell({ title = 'Settings', tabs, children }: SettingsShellProps) {
  const location = useLocation();
  const { class: classSlug } = useParams();

  const currentTab = location.pathname.split('/').pop() || 'general';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1
        className="display"
        style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
      >
        {title}
      </h1>

      <nav
        className="caps"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--line)',
          paddingBottom: 0,
        }}
      >
        {tabs.map(tab => {
          const active = currentTab === tab.key;
          return (
            <Link
              key={tab.key}
              to={`/admin/${classSlug}/settings/${tab.key}`}
              style={{
                padding: '8px 12px',
                textDecoration: 'none',
                color: tab.danger
                  ? '#c0392b'
                  : active
                    ? 'var(--ink-0)'
                    : 'var(--ink-3)',
                borderBottom: active
                  ? `2px solid ${tab.danger ? '#c0392b' : 'var(--ink-0)'}`
                  : '2px solid transparent',
                marginBottom: -1,
                fontWeight: active ? 600 : 500,
                transition: 'color 120ms ease',
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div>{children}</div>
    </div>
  );
}

export default SettingsShell;
