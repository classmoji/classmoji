import { IconSearch, IconPlus } from '@classmoji/ui-components';
import {
  RosterRow,
  RosterInviteRow,
  ROSTER_GRID_TEMPLATE,
  ROSTER_INVITE_GRID_TEMPLATE,
  type RosterStudent,
  type RosterInvite,
} from './RosterRow';

interface RosterScreenProps {
  students: RosterStudent[];
  invitations?: RosterInvite[];
  /** Absolute URL of the parent route, used to target the revokeInvite action. */
  revokeActionUrl?: string;
  onAddStudents?: () => void;
  onSearch?: () => void;
}

export function RosterScreen({
  students,
  invitations = [],
  revokeActionUrl = '',
  onAddStudents,
  onSearch,
}: RosterScreenProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1
          className="display"
          style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
        >
          Roster
        </h1>
        <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
          {students.length} {students.length === 1 ? 'student' : 'students'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onSearch}>
          <IconSearch size={14} /> Search
        </button>
        {onAddStudents ? (
          <button type="button" className="btn btn-primary" onClick={onAddStudents}>
            <IconPlus size={14} /> Add students
          </button>
        ) : null}
      </div>

      {invitations.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              paddingLeft: 2,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--ink-2)',
                letterSpacing: 0.1,
              }}
            >
              Pending invitations
            </h2>
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {invitations.length}
            </span>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="caps"
              style={{
                display: 'grid',
                gridTemplateColumns: ROSTER_INVITE_GRID_TEMPLATE,
                gap: 16,
                padding: '10px 18px',
                borderBottom: '1px solid var(--line)',
                background: 'rgba(250, 250, 249, 0.5)',
              }}
            >
              <span />
              <span>Email</span>
              <span>Status</span>
              <span>Invited</span>
              <span />
            </div>
            {invitations.map((inv, i) => (
              <RosterInviteRow
                key={inv.id}
                invite={inv}
                actionUrl={revokeActionUrl}
                last={i === invitations.length - 1}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          className="caps"
          style={{
            display: 'grid',
            gridTemplateColumns: ROSTER_GRID_TEMPLATE,
            gap: 16,
            padding: '10px 18px',
            borderBottom: '1px solid var(--line)',
            background: 'rgba(250, 250, 249, 0.5)',
          }}
        >
          <span />
          <span>Student</span>
          <span>Submitted</span>
          <span>Avg grade</span>
          <span>Tokens</span>
          <span>Focus</span>
          <span />
        </div>
        {students.length === 0 ? (
          <div
            style={{
              padding: '28px 18px',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
            }}
          >
            No students enrolled yet.
          </div>
        ) : (
          students.map((s, i) => (
            <RosterRow key={s.id} student={s} last={i === students.length - 1} />
          ))
        )}
      </div>
    </div>
  );
}

export default RosterScreen;
