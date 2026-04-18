import { Link } from 'react-router';
import { Chip, IconArrowR, IconCheck } from '@classmoji/ui-components';

export interface ModuleCardItem {
  kind: 'QUIZ' | 'ASGN';
  title: string;
  date: string;
  done?: boolean;
}

export interface ModuleCardData {
  // TODO: Module schema has no integer index; show when one lands
  number: string | number | null;
  name: string;
  assignmentCount: number;
  weeks: string;
  pct: number;
  items: ModuleCardItem[];
}

interface ModuleCardProps {
  module: ModuleCardData | null;
  viewModuleHref: string;
  primaryActionHref?: string;
  primaryActionLabel?: string;
}

export function ModuleCard({
  module,
  viewModuleHref,
  primaryActionHref,
  primaryActionLabel,
}: ModuleCardProps) {
  if (!module) {
    return (
      <div className="card" style={{ padding: 22 }}>
        <div className="caps" style={{ marginBottom: 6 }}>Current module</div>
        <div style={{ color: 'var(--ink-2)', fontSize: 13 }}>
          No active module right now.
        </div>
      </div>
    );
  }
  const m = module;
  const pct = Math.max(0, Math.min(100, Math.round(m.pct)));
  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="caps" style={{ marginBottom: 6 }}>
        {m.number != null ? `Module #${m.number}` : 'Current module'}
      </div>
      <h2
        className="display"
        style={{ margin: 0, fontSize: 24, fontWeight: 500, letterSpacing: -0.4 }}
      >
        {m.name}
      </h2>
      <div style={{ color: 'var(--ink-2)', fontSize: 12.5, marginTop: 3 }}>
        {m.assignmentCount} assignments · Weeks {m.weeks}
      </div>

      {/* Progress */}
      <div style={{ marginTop: 16 }}>
        <div
          style={{
            height: 6,
            borderRadius: 99,
            background: 'var(--bg-3)',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background:
                'linear-gradient(90deg, oklch(78% 0.12 285), oklch(62% 0.19 285))',
              borderRadius: 99,
            }}
          />
        </div>
        <div
          style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}
        >
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Progress</span>
          <span
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-1)' }}
            className="mono"
          >
            {pct}%
          </span>
        </div>
      </div>

      {/* This week list */}
      {m.items.length > 0 && (
        <>
          <div className="caps" style={{ marginTop: 20, marginBottom: 6 }}>
            This week
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {m.items.map((it, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 2px',
                  borderBottom:
                    i < m.items.length - 1 ? '1px solid var(--line)' : 'none',
                }}
              >
                <Chip variant={it.kind === 'QUIZ' ? 'quiz' : 'asgn'}>{it.kind}</Chip>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500 }}>
                  {it.title}
                </span>
                <span
                  style={{ fontSize: 12, color: 'var(--ink-3)' }}
                  className="mono"
                >
                  {it.date}
                </span>
                {it.done && (
                  <span style={{ color: 'oklch(60% 0.15 155)' }}>
                    <IconCheck size={14} />
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Link
          to={viewModuleHref}
          className="btn"
          style={{ flex: '0 0 auto', textDecoration: 'none' }}
        >
          View module
        </Link>
        {primaryActionHref && primaryActionLabel && (
          <Link
            to={primaryActionHref}
            className="btn btn-primary"
            style={{ flex: 1, textDecoration: 'none' }}
          >
            {primaryActionLabel} <IconArrowR size={14} />
          </Link>
        )}
      </div>
    </div>
  );
}

export default ModuleCard;
