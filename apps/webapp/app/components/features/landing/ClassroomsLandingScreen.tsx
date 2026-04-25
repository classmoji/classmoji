import { useState, useMemo } from 'react';
import { Link } from 'react-router';
import { Button, IconGithub, IconPlus, IconChevron, IconX } from '@classmoji/ui-components';
import { AppBar } from './AppBar';
import { ClassroomCard } from './ClassroomCard';
import { ClassroomRow, ClassroomRowHeader } from './ClassroomRow';
import type { LandingClass, TermSection } from './types';
import type { BellNotification, NotificationRole } from '~/components/features/notifications';

interface Props {
  user: { name?: string | null; login?: string | null; avatar_url?: string | null } | null;
  classes: LandingClass[];
  termSections: TermSection[];
  activeTermLabel: string | null;
  onOpenClass: (c: LandingClass) => void;
  notifications?: BellNotification[];
  unreadCount?: number;
  membershipRoles?: Record<string, NotificationRole[]>;
}

type TabId = 'all' | 'teaching' | 'learning' | 'archived';

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
  termSections,
  activeTermLabel,
  onOpenClass,
  notifications,
  unreadCount,
  membershipRoles,
}: Props) {
  const [tab, setTab] = useState<TabId>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [bannerOpen, setBannerOpen] = useState(true);

  const counts = useMemo(
    () => ({
      all: classes.filter(c => !c.archived).length,
      teaching: classes.filter(c => !c.archived && (c.role === 'OWNER' || c.role === 'ASSISTANT'))
        .length,
      learning: classes.filter(c => !c.archived && c.role === 'STUDENT').length,
      archived: classes.filter(c => c.archived).length,
    }),
    [classes]
  );

  const filteredSections = useMemo(() => {
    const filterClass = (c: LandingClass) => {
      if (tab === 'teaching') return !c.archived && (c.role === 'OWNER' || c.role === 'ASSISTANT');
      if (tab === 'learning') return !c.archived && c.role === 'STUDENT';
      if (tab === 'archived') return c.archived;
      return !c.archived;
    };
    return termSections
      .map(s => ({ ...s, classes: s.classes.filter(filterClass) }))
      .filter(s => s.classes.length > 0);
  }, [termSections, tab]);

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
              {activeTermLabel && (
                <>
                  <span style={{ color: 'var(--ink-4)', margin: '0 6px' }}>·</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{activeTermLabel}</span> in
                  progress
                </>
              )}
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
              <b style={{ fontWeight: 600 }}>Token economy is live this term.</b> Students earn
              tokens for early submissions and spend them on deadline extensions — configure the
              rate in class settings.
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
          <div
            style={{
              display: 'flex',
              gap: 2,
              padding: 2,
              background: 'var(--bg-3)',
              border: '1px solid var(--line)',
              borderRadius: 7,
            }}
          >
            {(
              [
                ['all', 'All', counts.all],
                ['teaching', 'Teaching', counts.teaching],
                ['learning', 'Learning', counts.learning],
                ['archived', 'Archived', counts.archived],
              ] as const
            ).map(([id, label, n]) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 5,
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: active ? 'var(--ink-0)' : 'var(--ink-2)',
                    background: active ? 'var(--bg-1)' : 'transparent',
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    border: 'none',
                  }}
                >
                  {label}{' '}
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: active ? 'var(--ink-2)' : 'var(--ink-3)',
                    }}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ flex: 1 }} />

          <button type="button" className="btn" style={{ color: 'var(--ink-2)' }}>
            Sort: Recent <IconChevron size={12} />
          </button>

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

        {filteredSections.length === 0 && (
          <div
            style={{
              border: '1px dashed var(--line-2)',
              borderRadius: 8,
              padding: 40,
              textAlign: 'center',
              color: 'var(--ink-3)',
            }}
          >
            Nothing here. Try a different filter.
          </div>
        )}

        {filteredSections.map(term => (
          <section key={term.id} style={{ marginTop: 26 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingBottom: 10,
                marginBottom: 12,
                borderBottom: '1px dashed var(--line)',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--ink-2)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                {term.label}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--ink-3)',
                }}
              >
                · {term.meta}
              </span>
              <div style={{ flex: 1 }} />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--ink-3)',
                }}
              >
                {term.classes.length} {term.classes.length === 1 ? 'class' : 'classes'}
              </span>
            </div>

            {view === 'grid' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 12,
                }}
              >
                {term.classes.map(c => (
                  <ClassroomCard key={c.id} c={c} onOpen={() => onOpenClass(c)} />
                ))}
                {term.id === 'spring' && (
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
                    <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      or import from GitHub
                    </span>
                  </Link>
                )}
              </div>
            ) : (
              <div
                style={{
                  background: 'var(--bg-1)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <ClassroomRowHeader />
                {term.classes.map(c => (
                  <ClassroomRow key={c.id} c={c} onOpen={() => onOpenClass(c)} />
                ))}
              </div>
            )}
          </section>
        ))}

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
