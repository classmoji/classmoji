import { IconGithub } from '@classmoji/ui-components';
import { ClassMark } from './ClassMark';
import { RoleChip } from './RoleChip';
import type { LandingClass } from './types';

interface ClassroomCardProps {
  c: LandingClass;
  onOpen: () => void;
}

export function ClassroomCard({ c, onOpen }: ClassroomCardProps) {
  const roleVerb =
    c.role === 'OWNER' || c.role === 'ASSISTANT'
      ? 'To grade'
      : c.role === 'STUDENT'
        ? 'Open'
        : 'Pending';

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
      style={{
        position: 'relative',
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '14px 14px 12px',
        cursor: 'pointer',
        transition: 'border-color 120ms, background 120ms',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minHeight: 150,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--line-strong)';
        e.currentTarget.style.background = 'var(--panel-hover)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--line)';
        e.currentTarget.style.background = 'var(--bg-1)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <ClassMark hue={c.hue} name={c.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink-0)',
              letterSpacing: '-0.01em',
            }}
          >
            {c.name}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--ink-3)',
              marginTop: 1,
            }}
          >
            {c.slug}
          </div>
        </div>
        <RoleChip role={c.role} />
      </div>

      {c.subtitle && (
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.4, marginTop: -2 }}>
          {c.subtitle}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 14,
          paddingTop: 10,
          borderTop: '1px solid var(--line)',
          marginTop: 'auto',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>Roster</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              color: 'var(--ink-0)',
              fontWeight: 500,
            }}
          >
            {c.students}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{roleVerb}</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              fontWeight: 500,
              color:
                c.pending === 0
                  ? 'var(--ink-3)'
                  : c.role === 'STUDENT'
                    ? '#8a2a16'
                    : '#1a6b3e',
            }}
          >
            {c.pending}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 11, flex: 1 }}>
          <span style={{ color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>Term progress</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              color: 'var(--ink-0)',
              fontWeight: 500,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 48,
                  height: 4,
                  borderRadius: 99,
                  background: 'var(--bg-3)',
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'inline-block',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${c.progress}%`,
                    background: c.progress >= 100 ? '#1a6b3e' : 'var(--violet)',
                  }}
                />
              </span>
              <span style={{ fontSize: 11, color: 'var(--ink-2)' }}>{c.progress}%</span>
            </span>
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--ink-3)',
        }}
      >
        <IconGithub size={12} />
        <span style={{ fontFamily: 'var(--font-mono)' }}>main</span>
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--ink-4)',
            display: 'inline-block',
          }}
        />
        <span>updated {c.updated}</span>
      </div>
    </div>
  );
}
