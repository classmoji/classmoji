import { Link } from 'react-router';
import { Avatar, IconChevronR } from '@classmoji/ui-components';

export const ROSTER_GRID_TEMPLATE = '36px 1.4fr 100px 120px 100px 90px 30px';

export interface RosterStudent {
  id: string;
  name: string;
  initials: string;
  hue: number;
  /** Formatted as "done/total" e.g. "8/10". */
  submitted: string;
  /** Numeric average grade (0-100) or null when no grades. */
  avg: number | null;
  /** Emoji symbol to show alongside avg, or null. */
  avgEmoji: string | null;
  /** Token balance. */
  tokens: number;
  /** Focus percent (0-100) or null when no data. */
  focus: number | null;
  /** Destination URL for the row click. */
  href: string;
}

interface RosterRowProps {
  student: RosterStudent;
  last?: boolean;
}

export function RosterRow({ student, last }: RosterRowProps) {
  const { name, initials, hue, submitted, avg, avgEmoji, tokens, focus, href } = student;
  return (
    <Link
      to={href}
      className="row-hover"
      style={{
        display: 'grid',
        gridTemplateColumns: ROSTER_GRID_TEMPLATE,
        gap: 16,
        padding: '12px 18px',
        alignItems: 'center',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        color: 'inherit',
        textDecoration: 'none',
        cursor: 'pointer',
      }}
    >
      <Avatar initials={initials} hue={hue} size={28} />
      <span style={{ fontSize: 13.5, fontWeight: 500 }}>{name}</span>
      <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
        {submitted}
      </span>
      <span style={{ fontSize: 13 }}>
        {avg === null ? (
          <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>—</span>
        ) : (
          <>
            {avgEmoji ? (
              <span style={{ fontSize: 14, marginRight: 4 }}>{avgEmoji}</span>
            ) : null}
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
              {Math.round(avg)}
            </span>
          </>
        )}
      </span>
      <span className="mono" style={{ fontSize: 12.5, color: 'oklch(50% 0.14 80)' }}>
        🪙 {tokens}
      </span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
        {focus === null ? '—' : `${focus}%`}
      </span>
      <span style={{ color: 'var(--ink-4)' }}>
        <IconChevronR size={14} />
      </span>
    </Link>
  );
}

export default RosterRow;
