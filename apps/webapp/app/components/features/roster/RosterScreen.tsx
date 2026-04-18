import { IconSearch, IconPlus } from '@classmoji/ui-components';
import { RosterRow, ROSTER_GRID_TEMPLATE, type RosterStudent } from './RosterRow';

interface RosterScreenProps {
  students: RosterStudent[];
  onAddStudents?: () => void;
  onSearch?: () => void;
}

export function RosterScreen({ students, onAddStudents, onSearch }: RosterScreenProps) {
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
