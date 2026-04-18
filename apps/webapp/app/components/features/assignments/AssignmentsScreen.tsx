import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AssignmentRow, ASSIGNMENT_GRID_TEMPLATE } from './AssignmentRow';
import {
  ASSIGNMENT_FILTERS,
  type AssignmentFilter,
  type AssignmentRow as AssignmentRowData,
} from './assignmentsTypes';

interface AssignmentsScreenProps {
  assignments: AssignmentRowData[];
  /** Optional title override (e.g., role-specific copy). Defaults to "Assignments". */
  title?: string;
  /** Slot on the right of the title row (before filter bar) — e.g., admin "New" button. */
  headerActions?: ReactNode;
  /** Empty state override. */
  emptyState?: ReactNode;
}

export function AssignmentsScreen({
  assignments,
  title = 'Assignments',
  headerActions,
  emptyState,
}: AssignmentsScreenProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawFilter = (searchParams.get('filter') || 'all') as AssignmentFilter;
  const filter: AssignmentFilter = ASSIGNMENT_FILTERS.some(f => f.id === rawFilter)
    ? rawFilter
    : 'all';

  const items = assignments.filter(a => {
    if (filter === 'all') return true;
    if (filter === 'open') return a.state === 'open';
    if (filter === 'graded') return a.state === 'graded';
    if (filter === 'upcoming') return a.state === 'upcoming';
    return true;
  });

  const setFilter = (id: AssignmentFilter) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'all') next.delete('filter');
    else next.set('filter', id);
    setSearchParams(next, { replace: true, preventScrollReset: true });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1
          className="display"
          style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
        >
          {title}
        </h1>
        <div style={{ flex: 1 }} />
        {headerActions}
        <div
          style={{
            display: 'flex',
            gap: 2,
            padding: 3,
            background: 'white',
            border: '1px solid var(--line)',
            borderRadius: 10,
          }}
        >
          {ASSIGNMENT_FILTERS.map(f => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 7,
                  fontSize: 12.5,
                  fontWeight: 500,
                  background: active ? 'var(--bg-3)' : 'transparent',
                  color: active ? 'var(--ink-0)' : 'var(--ink-2)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          className="caps"
          style={{
            display: 'grid',
            gridTemplateColumns: ASSIGNMENT_GRID_TEMPLATE,
            gap: 16,
            padding: '10px 18px',
            borderBottom: '1px solid var(--line)',
            background: 'rgba(250, 250, 249, 0.5)',
          }}
        >
          <span>Kind</span>
          <span>Title</span>
          <span>Mod</span>
          <span>Due</span>
          <span>Status</span>
          <span />
        </div>
        {items.length === 0 ? (
          <div
            style={{
              padding: '28px 18px',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
            }}
          >
            {emptyState ?? 'No assignments match this filter.'}
          </div>
        ) : (
          items.map((item, i) => (
            <AssignmentRow key={item.id} item={item} last={i === items.length - 1} />
          ))
        )}
      </div>
    </div>
  );
}

export default AssignmentsScreen;
