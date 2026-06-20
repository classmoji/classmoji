import { useState, useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Button, IconGithub, IconPlus } from '@classmoji/ui-components';
import { IconRoute } from '@tabler/icons-react';
import { ClassroomCard } from './ClassroomCard';
import { ClassroomRow, ClassroomRowHeader } from './ClassroomRow';
import type { LandingClass } from './types';
import type { BellNotification, NotificationRole } from '~/components/features/notifications';

interface Props {
  user: { name?: string | null; login?: string | null; avatar_url?: string | null } | null;
  classes: LandingClass[];
  onOpenClass: (c: LandingClass) => void;
  /** Launch the guided tour (walks the hidden Example Course). */
  onTakeTour?: () => void;
  /** Whether an Example Course exists to tour. */
  tourAvailable?: boolean;
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
  onTakeTour,
  tourAvailable,
  notifications,
  unreadCount,
  membershipRoles,
}: Props) {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [tourSpin, setTourSpin] = useState(false);

  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const [pinOverrides, setPinOverrides] = useState<Record<string, number | null>>({});
  const [archiveOverrides, setArchiveOverrides] = useState<Record<string, boolean>>({});

  const classesSigRef = useRef<string>('');
  useEffect(() => {
    const sig = classes
      .map(c => `${c.id}:${c.pin_order ?? ''}:${c.is_archived ? '1' : '0'}`)
      .join('|');
    if (sig !== classesSigRef.current) {
      classesSigRef.current = sig;
      setPinOverrides({});
      setArchiveOverrides({});
    }
  }, [classes]);

  const effectivePinOrder = (c: LandingClass): number | null =>
    Object.prototype.hasOwnProperty.call(pinOverrides, c.id) ? pinOverrides[c.id] : c.pin_order;
  const effectiveIsArchived = (c: LandingClass): boolean =>
    Object.prototype.hasOwnProperty.call(archiveOverrides, c.id)
      ? archiveOverrides[c.id]
      : c.is_archived;

  const handlePinChanged = (id: string, pin_order: number | null) => {
    setPinOverrides(prev => ({ ...prev, [id]: pin_order }));
  };

  const { pinned, active, archived } = useMemo(() => {
    const withEffective = classes.map(c => ({
      c: { ...c, is_archived: effectiveIsArchived(c), pin_order: effectivePinOrder(c) },
      p: effectivePinOrder(c),
      a: effectiveIsArchived(c),
    }));
    const pinned = withEffective
      .filter(x => x.p != null && !x.a)
      .sort((a, b) => (a.p ?? 0) - (b.p ?? 0))
      .map(x => x.c);
    const active = withEffective.filter(x => x.p == null && !x.a).map(x => x.c);
    const archived = withEffective.filter(x => x.a).map(x => x.c);
    return { pinned, active, archived };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, pinOverrides, archiveOverrides]);

  const dragIdRef = useRef<string | null>(null);
  const [pinnedOrder, setPinnedOrder] = useState<string[] | null>(null);

  const pinnedDisplay = useMemo(() => {
    if (!pinnedOrder) return pinned;
    const byId = new Map(pinned.map(c => [c.id, c]));
    const ordered = pinnedOrder.map(id => byId.get(id)).filter(Boolean) as LandingClass[];
    for (const c of pinned) if (!pinnedOrder.includes(c.id)) ordered.push(c);
    return ordered;
  }, [pinned, pinnedOrder]);

  useEffect(() => {
    setPinnedOrder(null);
  }, [classes]);

  const submitReorder = async (ids: string[]) => {
    const prev = pinnedOrder;
    setPinnedOrder(ids);
    try {
      const byId = new Map(classes.map(c => [c.id, c]));
      const items = ids
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(c => ({
          classroom_id: (c as LandingClass).classroomId,
          role: (c as LandingClass).membershipRole,
        }));
      const res = await fetch('/api/classrooms/reorder-pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        setPinnedOrder(prev);
      } else {
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
      all: classes.filter(c => !effectiveIsArchived(c)).length,
      archived: classes.filter(c => effectiveIsArchived(c)).length,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classes, archiveOverrides]
  );

  const isDuplicate = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const c of classes) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
    return (name: string) => (nameCounts.get(name) ?? 0) > 1;
  }, [classes]);

  const renderGrid = (items: LandingClass[], draggable = false) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      <AnimatePresence initial={false}>
        {items.map(c => (
          <motion.div
            key={c.id}
            layout
            layoutId={c.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 200, damping: 24 }}
          >
            <ClassroomCard
              c={c}
              onOpen={() => onOpenClass(c)}
              showSlug={isDuplicate(c.name)}
              onPinChanged={handlePinChanged}
              draggable={draggable}
              onDragStart={draggable ? handleDragStart(c.id) : undefined}
              onDragOver={draggable ? handleDragOver(c.id) : undefined}
              onDrop={draggable ? handleDrop(c.id) : undefined}
              onDragEnd={draggable ? handleDragEnd : undefined}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );

  const renderList = (items: LandingClass[]) => (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="bg-panel ring-1 ring-line rounded-2xl overflow-hidden sm:min-w-[700px]">
        <ClassroomRowHeader />
        {items.map(c => (
          <ClassroomRow key={c.id} c={c} onOpen={() => onOpenClass(c)} />
        ))}
      </div>
    </div>
  );

  const sectionHeading = (label: string, count: number) => (
    <div className="text-sm font-semibold text-ink-3 mb-2.5 mt-1">
      {label} <span className="text-xs text-ink-4 font-normal">{count}</span>
    </div>
  );

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end gap-4 pb-5 mb-6">
        <div className="flex-1">
          <h1 className="text-base font-semibold text-ink-2 m-0">
            Your classes
            <span className="ml-2 text-sm font-normal text-ink-4">
              {counts.all} active
              <span className="text-gray-300 dark:text-gray-600 mx-1">·</span>
              {counts.archived} archived
            </span>
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {tourAvailable && onTakeTour && (
            <Button
              data-onboarding="take-tour"
              className="cm-take-tour"
              onClick={() => {
                setTourSpin(true);
                // Let the icon spin briefly before the tour mask covers the page.
                window.setTimeout(() => onTakeTour?.(), 350);
              }}
            >
              <IconRoute
                size={14}
                className={tourSpin ? 'cm-route-spin' : ''}
                onAnimationEnd={() => setTourSpin(false)}
              />{' '}
              Take a tour
            </Button>
          )}
          <Link to="/import-classroom" data-onboarding="import">
            <Button>
              <IconGithub size={14} /> Import from GitHub Classroom
            </Button>
          </Link>
          <Link to="/create-classroom" data-onboarding="new-class">
            <Button variant="primary">
              <IconPlus size={14} /> New class
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1" />

        <div className="flex rounded-lg ring-1 ring-line overflow-hidden">
          <button
            type="button"
            onClick={() => setView('grid')}
            title="Grid"
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            className={`px-2.5 py-1.5 text-xs border-none cursor-pointer inline-flex items-center transition-colors ${
              view === 'grid'
                ? 'bg-nav-hover text-ink-0'
                : 'bg-panel text-ink-4 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
          >
            <ViewGridIcon />
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            title="List"
            aria-label="List view"
            aria-pressed={view === 'list'}
            className={`px-2.5 py-1.5 text-xs border-none cursor-pointer inline-flex items-center transition-colors ${
              view === 'list'
                ? 'bg-nav-hover text-ink-0'
                : 'bg-panel text-ink-4 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
          >
            <ViewListIcon />
          </button>
        </div>
      </div>

      {pinned.length === 0 && active.length === 0 && archived.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-line p-10 text-center text-ink-4">
          No classrooms yet.
        </div>
      ) : (
        <LayoutGroup>
          {pinnedDisplay.length > 0 && (
            <section className="mb-6">
              {sectionHeading('Pinned', pinnedDisplay.length)}
              {view === 'grid' ? renderGrid(pinnedDisplay, true) : renderList(pinnedDisplay)}
            </section>
          )}

          {active.length > 0 && (
            <section className="mb-6">
              {sectionHeading('Active', active.length)}
              {view === 'grid' ? renderGrid(active) : renderList(active)}
            </section>
          )}

          {archived.length > 0 && (
            <section className="mb-6">
              <button
                type="button"
                onClick={() => setArchivedExpanded(v => !v)}
                aria-expanded={archivedExpanded}
                className="inline-flex items-center gap-1.5 cursor-pointer mb-2.5 mt-1 bg-transparent border-none p-0 text-sm font-semibold text-ink-3"
              >
                <span aria-hidden>{archivedExpanded ? '▾' : '▸'}</span>
                <span>Archived</span>
                <span className="text-xs text-ink-4 font-normal">{archived.length}</span>
              </button>
              {archivedExpanded && (
                <div className="mt-2.5">
                  {view === 'grid' ? renderGrid(archived) : renderList(archived)}
                </div>
              )}
            </section>
          )}
        </LayoutGroup>
      )}
    </div>
  );
}
