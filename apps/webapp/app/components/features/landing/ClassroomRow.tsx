import { IconChevron } from '@classmoji/ui-components';
import { ClassMark } from './ClassMark';
import { RoleChip } from './RoleChip';
import type { LandingClass } from './types';

const TROW_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '36px 1.8fr 1fr 90px 110px 100px 110px 30px',
  gap: 16,
  alignItems: 'center',
  padding: '10px 14px',
  fontSize: 13,
  borderBottom: '1px solid var(--line)',
};

export function ClassroomRowHeader() {
  return (
    <div
      style={{
        ...TROW_STYLE,
        background: 'var(--bg-2)',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--ink-3)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      <span />
      <span>Class</span>
      <span>Description</span>
      <span>Role</span>
      <span>Roster</span>
      <span>Pending</span>
      <span>Updated</span>
      <span />
    </div>
  );
}

export function ClassroomRow({ c, onOpen }: { c: LandingClass; onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{ ...TROW_STYLE, cursor: 'pointer', transition: 'background 100ms' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-2)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <ClassMark hue={c.hue} name={c.name} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{c.name}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-3)' }}>
          {c.slug}
        </div>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--ink-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {c.subtitle || '—'}
      </div>
      <RoleChip role={c.role} />
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-1)' }}>
        {c.students} <span style={{ color: 'var(--ink-3)' }}>students</span>
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: c.pending ? 'var(--violet-ink)' : 'var(--ink-3)',
        }}
      >
        {c.pending || '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>updated {c.updated}</div>
      <span style={{ color: 'var(--ink-4)', transform: 'rotate(-90deg)', display: 'inline-flex' }}>
        <IconChevron size={12} />
      </span>
    </div>
  );
}
