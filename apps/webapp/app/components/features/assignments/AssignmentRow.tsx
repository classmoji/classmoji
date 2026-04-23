import { Link } from 'react-router';
import { Chip, StatusBadge, IconChevronR, type ChipVariant } from '@classmoji/ui-components';
import type { AssignmentRow as AssignmentRowData } from './assignmentsTypes';

const GRID_TEMPLATE = '90px 1fr 60px 110px 110px 30px';

const KIND_TO_VARIANT: Record<AssignmentRowData['kind'], ChipVariant> = {
  QUIZ: 'quiz',
  ASGN: 'asgn',
  PROJ: 'mod',
};

interface AssignmentRowProps {
  item: AssignmentRowData;
  last?: boolean;
}

export function AssignmentRow({ item, last }: AssignmentRowProps) {
  // Map our internal state -> StatusBadge primitive states.
  // 'closed' and 'draft' render as ghost chips with labels.
  const badge = renderBadge(item);
  return (
    <Link
      to={item.href}
      className="row-hover"
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_TEMPLATE,
        gap: 16,
        padding: '14px 18px',
        alignItems: 'center',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <span>
        <Chip variant={KIND_TO_VARIANT[item.kind]}>{item.kind}</Chip>
      </span>
      <span style={{ fontSize: 14, fontWeight: 500 }}>{item.title}</span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        {item.mod ? `MOD ${item.mod}` : '—'}
      </span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
        {item.due || '—'}
      </span>
      <span>{badge}</span>
      <span style={{ color: 'var(--ink-4)' }}>
        <IconChevronR size={14} />
      </span>
    </Link>
  );
}

function renderBadge(item: AssignmentRowData) {
  if (item.state === 'graded') {
    return <StatusBadge state="graded" emoji={item.emoji} pct={item.pct} />;
  }
  if (item.state === 'upcoming') {
    return <StatusBadge state="upcoming" />;
  }
  if (item.state === 'closed') {
    return <Chip variant="ghost">Closed</Chip>;
  }
  if (item.state === 'draft') {
    return <Chip variant="ghost">Draft</Chip>;
  }
  return <StatusBadge state="open" />;
}

export { GRID_TEMPLATE as ASSIGNMENT_GRID_TEMPLATE };
