export type StatusState = 'graded' | 'open' | 'upcoming';

export interface StatusBadgeProps {
  state: StatusState;
  emoji?: string | null;
  pct?: number | null;
}

/**
 * Ported from the redesign bundle (assignments.jsx:6-35).
 */
export function StatusBadge({ state, emoji, pct }: StatusBadgeProps) {
  if (state === 'graded') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px 3px 4px',
          borderRadius: 99,
          background: 'white',
          border: '1px solid var(--line)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span style={{ fontSize: 14 }}>{emoji}</span>
        <span className="mono">{pct}</span>
      </span>
    );
  }
  if (state === 'upcoming') {
    return <span className="chip chip-ghost">Upcoming</span>;
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 99,
        background: 'var(--violet-soft)',
        color: 'var(--violet-ink)',
        fontSize: 11.5,
        fontWeight: 600,
      }}
    >
      <span className="dot" style={{ background: 'var(--violet)' }} />
      Open
    </span>
  );
}
