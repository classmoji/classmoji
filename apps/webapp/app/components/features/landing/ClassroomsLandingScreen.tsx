import { useState, useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
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

  // Local overrides for optimistic pin/unpin, drag-reorder, and archive. Keyed by composite landing id.
  const [pinOverrides, setPinOverrides] = useState<Record<string, number | null>>({});
  const [archiveOverrides, setArchiveOverrides] = useState<Record<string, boolean>>({});

  // Reset overrides if upstream classes change (e.g. revalidation).
  const classesSigRef = useRef<string>('');
  useEffect(() => {
    const sig = classes
      .map(c => `${c.id}:${c.pin_order ?? ''}:${c.is_active ? '1' : '0'}`)
      .join('|');
    if (sig !== classesSigRef.current) {
      classesSigRef.current = sig;
      setPinOverrides({});
      setArchiveOverrides({});
    }
  }, [classes]);

  const effectivePinOrder = (c: LandingClass): number | null =>
    Object.prototype.hasOwnProperty.call(pinOverrides, c.id) ? pinOverrides[c.id] : c.pin_order;
  const effectiveIsActive = (c: LandingClass): boolean =>
    Object.prototype.hasOwnProperty.call(archiveOverrides, c.id)
      ? archiveOverrides[c.id]
      : c.is_active;

  const handlePinChanged = (id: string, pin_order: number | null) => {
    setPinOverrides(prev => ({ ...prev, [id]: pin_order }));
  };
  const handleArchiveChanged = (id: string, is_active: boolean) => {
    setArchiveOverrides(prev => ({ ...prev, [id]: is_active }));
  };

  const { pinned, active, archived } = useMemo(() => {
    const withEffective = classes.map(c => ({
      c: { ...c, is_active: effectiveIsActive(c), pin_order: effectivePinOrder(c) },
      p: effectivePinOrder(c),
      a: effectiveIsActive(c),
    }));
    const pinned = withEffective
      .filter(x => x.p != null && x.a)
      .sort((a, b) => (a.p ?? 0) - (b.p ?? 0))
      .map(x => x.c);
    const active = withEffective.filter(x => x.p == null && x.a).map(x => x.c);
    const archived = withEffective.filter(x => !x.a).map(x => x.c);
    return { pinned, active, archived };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, pinOverrides, archiveOverrides]);

  // Drag state for the Pinned section.
  const dragIdRef = useRef<string | null>(null);
  const [pinnedOrder, setPinnedOrder] = useState<string[] | null>(null);

  const pinnedDisplay = useMemo(() => {
    if (!pinnedOrder) return pinned;
    const byId = new Map(pinned.map(c => [c.id, c]));
    const ordered = pinnedOrder.map(id => byId.get(id)).filter(Boolean) as LandingClass[];
    // Append any pinned items not in pinnedOrder (e.g. a freshly pinned card).
    for (const c of pinned) if (!pinnedOrder.includes(c.id)) ordered.push(c);
    return ordered;
  }, [pinned, pinnedOrder]);

  useEffect(() => {
    // When the upstream pinned set changes shape, drop local drag order.
    setPinnedOrder(null);
  }, [classes]);

  const submitReorder = async (ids: string[]) => {
    const prev = pinnedOrder;
    setPinnedOrder(ids);
    try {
      // Translate composite UI ids → {classroom_id, role} pairs for the API.
      const byId = new Map(classes.map(c => [c.id, c]));
      const items = ids
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(c => ({ classroom_id: (c as LandingClass).classroomId, role: (c as LandingClass).membershipRole }));
      const res = await fetch('/api/classrooms/reorder-pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        setPinnedOrder(prev);
      } else {
        // Reflect new pin_order locally so reload of state is consistent.
        setPinOverrides(prevOverrides => {
          const next = { ...prevOverrides };
          ids.forEach((id, idx) => {
            next[id] = idx + 1;
          });
          return next;
        });
      }
    } catch {
      setPinnedOrder(prev);
    }
  };

  const handleDragStart = (id: string) => (e: React.DragEvent<HTMLDivElement>) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', id);
    } catch {
      /* noop */
    }
  };
  const handleDragOver = (_id: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (targetId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const sourceId = dragIdRef.current;
    dragIdRef.current = null;
    if (!sourceId || sourceId === targetId) return;
    const currentIds = pinnedDisplay.map(c => c.id);
    const from = currentIds.indexOf(sourceId);
    const to = currentIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = currentIds.slice();
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    void submitReorder(next);
  };
  const handleDragEnd = () => {
    dragIdRef.current = null;
  };

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

  const renderGrid = (items: LandingClass[], withNewCard: boolean, draggable = false) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 12,
      }}
    >
      <AnimatePresence initial={false}>
        {items.map(c => (
          <motion.div
            key={c.id}
            layout
            layoutId={c.id}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.6 }}
          >
            <ClassroomCard
              c={c}
              onOpen={() => onOpenClass(c)}
              showSlug={isDuplicate(c.name)}
              onPinChanged={handlePinChanged}
              onArchiveChanged={handleArchiveChanged}
              draggable={draggable}
              onDragStart={draggable ? handleDragStart(c.id) : undefined}
              onDragOver={draggable ? handleDragOver(c.id) : undefined}
              onDrop={draggable ? handleDrop(c.id) : undefined}
              onDragEnd={draggable ? handleDragEnd : undefined}
            />
          </motion.div>
        ))}
      </AnimatePresence>
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
          <LayoutGroup>
            {pinnedDisplay.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                {sectionHeading('Pinned', pinnedDisplay.length)}
                {view === 'grid'
                  ? renderGrid(pinnedDisplay, false, true)
                  : renderList(pinnedDisplay)}
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
          </LayoutGroup>
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
