import { Link } from 'react-router';
import { IconLock } from '@tabler/icons-react';
import type { ModuleCard } from './modulesTypes';

interface ModuleCardItemProps {
  module: ModuleCard;
}

export function ModuleCardItem({ module: m }: ModuleCardItemProps) {
  const isLocked = m.state === 'lock';
  const isDone = m.state === 'done';

  const fillStyle: React.CSSProperties = {
    width: `${Math.max(0, Math.min(100, m.pct))}%`,
  };
  if (isDone) {
    fillStyle.background = '#2f9b55';
  } else if (isLocked) {
    fillStyle.background = 'var(--ink-4)';
  }
  // else default to var(--accent) from .bar .fill

  const pctColor = isDone
    ? '#2f9b55'
    : isLocked
      ? 'var(--ink-3)'
      : 'var(--accent-ink)';

  const content = (
    <div
      className="panel"
      style={{
        padding: '14px 18px 16px',
        opacity: isLocked ? 0.75 : 1,
        cursor: isLocked ? 'default' : 'pointer',
      }}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="caps">Module #{m.number}</div>
          <div className="mt-[3px] text-[16px] font-semibold leading-snug">{m.name}</div>
          <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
            {m.subtitle}
          </div>
        </div>
        <div className="text-[12px] whitespace-nowrap" style={{ color: 'var(--ink-3)' }}>
          {m.weeks}
        </div>
      </div>

      {/* Progress bar row */}
      <div className="flex items-center gap-3 mt-[14px]">
        <div className="bar flex-1">
          <div className={`fill${isDone ? ' done' : ''}`} style={fillStyle} />
        </div>
        <div
          className="num text-[11.5px] font-semibold tabular-nums"
          style={{ color: pctColor }}
        >
          {m.pct}%
        </div>
      </div>

      {/* Status row */}
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-2.5 mt-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          {isDone && <span className="chip chip-done">Completed</span>}
          {m.state === 'prog' && <span className="chip chip-inprog">In progress</span>}
          {isLocked && (
            <span className="chip chip-locked inline-flex items-center gap-1">
              <IconLock size={11} stroke={2} /> Locked
            </span>
          )}
          <span
            className="text-[12px] truncate"
            style={{ color: 'var(--ink-2)' }}
          >
            {m.meta}
          </span>
        </div>
        <div className="flex-1 hidden md:block" />
        {m.timestamp && (
          <span className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
            {m.timestamp}
          </span>
        )}
      </div>
    </div>
  );

  if (isLocked) {
    return <div className="block no-underline text-current">{content}</div>;
  }

  return (
    <Link to={m.href} className="block no-underline text-current">
      {content}
    </Link>
  );
}

export default ModuleCardItem;
