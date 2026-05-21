import { useState, useMemo } from 'react';
import { Link } from 'react-router';
import { Button, IconGithub, IconPlus, IconX } from '@classmoji/ui-components';
import { AppBar } from './AppBar';
import { ClassroomCard } from './ClassroomCard';
import { ClassroomRow, ClassroomRowHeader } from './ClassroomRow';
import type { LandingClass } from './types';
import type { BellNotification, NotificationRole } from '~/components/features/notifications';

interface Props {
  user: { name?: string | null; login?: string | null; avatar_url?: string | null } | null;
  classes: LandingClass[];
  onOpenClass: (c: LandingClass) => void;
  notifications?: BellNotification[];
  unreadCount?: number;
  membershipRoles?: Record<string, NotificationRole[]>;
}

function ViewGridIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </svg>
  );
}
function ViewListIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function ClassroomsLandingScreen({
  user,
  classes,
  onOpenClass,
  notifications,
  unreadCount,
  membershipRoles,
}: Props) {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [bannerOpen, setBannerOpen] = useState(true);

  const { pinned, active, archived } = useMemo(() => {
    const pinned = classes
      .filter(c => c.pin_order != null)
      .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
    const active = classes.filter(c => c.pin_order == null && c.is_active);
    const archived = classes.filter(c => c.pin_order == null && !c.is_active);
    return { pinned, active, archived };
  }, [classes]);

  const counts = useMemo(
    () => ({
      all: classes.filter(c => !c.archived).length,
      archived: classes.filter(c => c.archived).length,
    }),
    [classes]
  );

  const isDuplicate = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const c of classes) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
    return (name: string) => (nameCounts.get(name) ?? 0) > 1;
  }, [classes]);

  const renderGrid = (items: LandingClass[], withNewCard: boolean) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 12,
      }}
    >
      {items.map(c => (
        <ClassroomCard
          key={c.id}
          c={c}
          onOpen={() => onOpenClass(c)}
          showSlug={isDuplicate(c.name)}
        />
      ))}
      {withNewCard && (
        <Link
          to="/create-classroom"
          style={{
            border: '1px dashed var(--line-2)',
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 6,
            color: 'var(--ink-2)',
            cursor: 'pointer',
            minHeight: 150,
            borderRadius: 8,
            transition: 'border-color 120ms, color 120ms, background 120ms',
            textDecoration: 'none',
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--bg-3)',
              color: 'var(--ink-2)',
            }}
          >
            <IconPlus size={14} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>New class</span>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>or import from GitHub</span>
        </Link>
      )}
    </div>
  );

  const renderList = (items: LandingClass[]) => (
    <div
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <ClassroomRowHeader />
      {items.map(c => (
        <ClassroomRow key={c.id} c={c} onOpen={() => onOpenClass(c)} />
      ))}
    </div>
  );

  const sectionHeading = (label: string, count: number) => (
    <div className="text-sm font-semibold text-gray-500 dark:text-gray-400" style={{ marginBottom: 10, marginTop: 4 }}>
      {label}{' '}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-3)', fontWeight: 400 }}>
        {count}
      </span>
    </div>
  );

  return (
    <div style={{ background: 'var(--bg-0)', minHeight: '100vh' }}>
      <AppBar
        user={user}
        notifications={notifications}
        unreadCount={unreadCount}
        membershipRoles={membershipRoles}
      />

      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '28px 32px 80px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 16,
            paddingBottom: 18,
            marginBottom: 22,
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div style={{ flex: 1 }}>
            <h1
              style={{
                fontSize: 28,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                margin: 0,
              }}
            >
              Your classes
            </h1>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', marginTop: 4 }}>
              <span className="num" style={{ color: 'var(--ink-1)' }}>
                {counts.all}
              </span>{' '}
              active
              <span style={{ color: 'var(--ink-4)', margin: '0 6px' }}>·</span>
              <span className="num" style={{ color: 'var(--ink-1)' }}>
                {counts.archived}
              </span>{' '}
              archived
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button>
              <IconGithub size={14} /> Import from GitHub Classroom
            </Button>
            <Link to="/create-classroom">
              <Button variant="primary">
                <IconPlus size={14} /> New class
              </Button>
            </Link>
          </div>
        </div>

        {bannerOpen && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              marginBottom: 16,
              border: '1px solid oklch(90% 0.04 230)',
              background: 'oklch(98% 0.02 230)',
              borderRadius: 8,
              fontSize: 12.5,
              color: '#1d4f8f',
            }}
          >
            <span style={{ fontSize: 14 }}>🪙</span>
            <span>
              <b style={{ fontWeight: 600 }}>Token economy is live.</b> Students earn tokens for
              early submissions and spend them on deadline extensions — configure the rate in class
              settings.
            </span>
            <button
              type="button"
              onClick={() => setBannerOpen(false)}
              style={{
                marginLeft: 'auto',
                color: '#1d4f8f',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
              }}
              aria-label="Dismiss"
            >
              <IconX size={12} />
            </button>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 18,
          }}
        >
          <div style={{ flex: 1 }} />

          <div
            style={{
              display: 'flex',
              border: '1px solid var(--line-2)',
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setView('grid')}
              title="Grid"
              style={{
                padding: '5px 10px',
                fontSize: 12,
                color: view === 'grid' ? 'var(--ink-0)' : 'var(--ink-2)',
                background: view === 'grid' ? 'var(--bg-3)' : 'var(--bg-1)',
                borderRight: '1px solid var(--line)',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <ViewGridIcon />
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              title="List"
              style={{
                padding: '5px 10px',
                fontSize: 12,
                color: view === 'list' ? 'var(--ink-0)' : 'var(--ink-2)',
                background: view === 'list' ? 'var(--bg-3)' : 'var(--bg-1)',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <ViewListIcon />
            </button>
          </div>
        </div>

        {pinned.length === 0 && active.length === 0 && archived.length === 0 ? (
          <div
            style={{
              border: '1px dashed var(--line-2)',
              borderRadius: 8,
              padding: 40,
              textAlign: 'center',
              color: 'var(--ink-3)',
            }}
          >
            No classrooms yet.
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                {sectionHeading('Pinned', pinned.length)}
                {view === 'grid' ? renderGrid(pinned, false) : renderList(pinned)}
              </section>
            )}

            {active.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                {sectionHeading('Active', active.length)}
                {view === 'grid' ? renderGrid(active, true) : renderList(active)}
              </section>
            )}

            {archived.length > 0 && (
              <details style={{ marginBottom: 24 }}>
                <summary
                  className="text-sm font-semibold text-gray-500 dark:text-gray-400"
                  style={{ cursor: 'pointer', marginBottom: 10, marginTop: 4, listStyle: 'revert' }}
                >
                  Archived{' '}
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--ink-3)',
                      fontWeight: 400,
                    }}
                  >
                    {archived.length}
                  </span>
                </summary>
                <div style={{ marginTop: 10 }}>
                  {view === 'grid' ? renderGrid(archived, false) : renderList(archived)}
                </div>
              </details>
            )}
          </>
        )}

        <footer
          style={{
            marginTop: 40,
            paddingTop: 18,
            borderTop: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontSize: 11.5,
            color: 'var(--ink-3)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span>classmoji</span>
          <span style={{ marginLeft: 'auto' }}>synced with GitHub</span>
        </footer>
      </div>
    </div>
  );
}
