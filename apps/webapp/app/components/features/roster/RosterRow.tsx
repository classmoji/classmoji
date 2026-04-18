import { useFetcher, Link } from 'react-router';
import { Avatar, Chip, IconChevronR } from '@classmoji/ui-components';

export const ROSTER_GRID_TEMPLATE = '36px 1.4fr 100px 120px 100px 90px 30px';
export const ROSTER_INVITE_GRID_TEMPLATE = '36px 1.4fr 1fr 90px 30px';

export interface RosterInvite {
  id: string;
  email: string;
  initials: string;
  hue: number;
  /** ISO date string. */
  invitedAt: string;
}

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

interface RosterInviteRowProps {
  invite: RosterInvite;
  actionUrl: string;
  last?: boolean;
}

const formatInvitedAt = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export function RosterInviteRow({ invite, actionUrl, last }: RosterInviteRowProps) {
  const { id, email, initials, hue, invitedAt } = invite;
  const fetcher = useFetcher();
  const isRevoking = fetcher.state !== 'idle';

  const handleRevoke = () => {
    if (isRevoking) return;
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(`Revoke invitation for ${email}?`);
      if (!confirmed) return;
    }
    fetcher.submit(
      { inviteId: id },
      {
        method: 'post',
        action: `${actionUrl}?/revokeInvite`,
        encType: 'application/json',
      }
    );
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: ROSTER_INVITE_GRID_TEMPLATE,
        gap: 16,
        padding: '12px 18px',
        alignItems: 'center',
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      <Avatar initials={initials} hue={hue} size={28} />
      <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-1)' }}>{email}</span>
      <span>
        <Chip variant="ghost">Pending</Chip>
      </span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        {formatInvitedAt(invitedAt)}
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={handleRevoke}
        disabled={isRevoking}
        aria-label={`Revoke invitation for ${email}`}
        style={{ padding: '4px 8px', fontSize: 12 }}
      >
        {isRevoking ? '…' : 'Revoke'}
      </button>
    </div>
  );
}
