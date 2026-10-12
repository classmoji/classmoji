import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSectionStats } from '~/hooks/useSectionStats.ts';
import {
  ACTIVITY_COPY,
  activityCount,
  activityLabel,
  activityListUrl,
  isNoSuchSection,
  parseActivityList,
  type ActivityPerson,
  type SectionActivityKind,
} from './sectionActivity.ts';

/**
 * The staff chip on a locked section ("Unlocked by X of Y") or a checkable
 * heading ("Done by X of Y"), and the list it opens: who among the current
 * students did it, and when. Counts come from `SectionStatsContext` (the
 * loader sends them to OWNER/TEACHER only); without them there is no chip.
 */
export function SectionActivityChip({
  kind,
  blockId,
  className,
}: {
  kind: SectionActivityKind;
  blockId: string;
  className?: string;
}) {
  const { pageId, stats } = useSectionStats();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  if (!stats) return null;
  const count = activityCount(stats, kind, blockId);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={className ? `pg-activity-chip ${className}` : 'pg-activity-chip'}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Keeps the editor's selection and focus where they are.
        onMouseDown={event => event.preventDefault()}
        onClick={() => setOpen(value => !value)}
      >
        <PeopleGlyph />
        {activityLabel(kind, count, stats.students)}
      </button>
      {open && pageId ? (
        <SectionActivityPopover
          kind={kind}
          anchor={chipRef}
          pageId={pageId}
          blockId={blockId}
          students={stats.students}
          onClose={returnFocus => {
            setOpen(false);
            if (returnFocus) chipRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </>
  );
}

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; students: number; people: ActivityPerson[] };

const timeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
}

const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#0d9488',
  '#4f46e5',
  '#65a30d',
  '#b45309',
];

function avatarColor(key: string): string {
  const sum = [...key].reduce((total, ch) => total + ch.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

const POPOVER_WIDTH = 300;

/**
 * Who unlocked / ticked this block, newest first. Portaled to <body>: inside
 * the block it would sit in ProseMirror's DOM, where clicks become selections.
 */
function SectionActivityPopover({
  kind,
  anchor,
  pageId,
  blockId,
  students,
  onClose,
}: {
  kind: SectionActivityKind;
  anchor: React.RefObject<HTMLButtonElement | null>;
  pageId: string;
  blockId: string;
  /** The loader's student count, for a block the saved page does not have yet. */
  students: number;
  onClose: (returnFocus: boolean) => void;
}) {
  const copy = ACTIVITY_COPY[kind];
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const popRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const studentsRef = useRef(students);
  studentsRef.current = students;

  useEffect(() => {
    const controller = new AbortController();
    fetch(activityListUrl(pageId, blockId, kind), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then(async response => {
        const body: unknown = await response.json().catch(() => null);
        if (response.ok) {
          const { students: total, people } = parseActivityList(kind, body);
          setState({ status: 'ready', students: total, people });
        } else if (isNoSuchSection(response.status, body)) {
          setState({ status: 'ready', students: studentsRef.current, people: [] });
        } else {
          setState({ status: 'error' });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [pageId, blockId, kind]);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 32);
      const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16));
      setPosition({ top: rect.bottom + 6, left, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (popRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onCloseRef.current(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor]);

  if (typeof document === 'undefined' || !position) return null;

  let body: React.ReactNode;
  let header = copy.label;
  if (state.status === 'loading') {
    body = <div className="pg-activity-pop-status">Loading…</div>;
  } else if (state.status === 'error') {
    body = <div className="pg-activity-pop-status">Couldn’t load the list. Try again.</div>;
  } else {
    header = activityLabel(kind, state.people.length, state.students);
    body =
      state.people.length === 0 ? (
        <div className="pg-activity-pop-empty">
          <div className="pg-activity-pop-empty-title">{copy.emptyTitle}</div>
          <div className="pg-activity-pop-empty-text">{copy.emptyText}</div>
        </div>
      ) : (
        <ul className="pg-activity-pop-list">
          {state.people.map(row => {
            const name = row.name || row.login || 'Unknown';
            return (
              <li key={row.userId}>
                {row.avatarUrl ? (
                  <img className="pg-activity-avatar" src={row.avatarUrl} alt="" />
                ) : (
                  <span
                    className="pg-activity-avatar"
                    style={{ background: avatarColor(name) }}
                    aria-hidden="true"
                  >
                    {initials(name)}
                  </span>
                )}
                <span className="pg-activity-name">{name}</span>
                <time dateTime={row.at}>{formatTime(row.at)}</time>
              </li>
            );
          })}
        </ul>
      );
  }

  return createPortal(
    <div
      ref={popRef}
      className="pg-activity-pop"
      role="dialog"
      aria-label={copy.label}
      style={{ top: position.top, left: position.left, width: position.width }}
    >
      <div className="pg-activity-pop-header">{header}</div>
      {body}
    </div>,
    document.body
  );
}

function PeopleGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
