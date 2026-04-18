import { Link } from 'react-router';
import type { ModuleCard } from './modulesTypes';

interface ModuleCardItemProps {
  module: ModuleCard;
}

export function ModuleCardItem({ module: m }: ModuleCardItemProps) {
  const numberLabel = m.number < 10 ? `0${m.number}` : String(m.number);
  const barBackground =
    m.pct >= 100
      ? 'linear-gradient(90deg, oklch(78% 0.12 155), oklch(62% 0.17 155))'
      : 'linear-gradient(90deg, oklch(78% 0.12 285), oklch(62% 0.19 285))';

  return (
    <Link
      to={m.href}
      className="card"
      style={{
        padding: 20,
        textDecoration: 'none',
        color: 'inherit',
        display: 'block',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span
          className="display"
          style={{
            fontSize: 48,
            fontWeight: 400,
            color: 'var(--ink-4)',
            letterSpacing: -2,
            lineHeight: 1,
          }}
        >
          {numberLabel}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{m.name}</div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Weeks {m.weeks} · {m.done}/{m.total} complete
          </div>
        </div>
      </div>
      <div
        style={{
          height: 6,
          background: 'var(--bg-3)',
          borderRadius: 99,
          marginTop: 16,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, m.pct))}%`,
            height: '100%',
            background: barBackground,
          }}
        />
      </div>
    </Link>
  );
}

export default ModuleCardItem;
