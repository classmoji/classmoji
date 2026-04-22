interface LateNoteCardProps {
  note: string;
}

/**
 * Ported from redesign (assignments.jsx:301-306).
 */
export function LateNoteCard({ note }: LateNoteCardProps) {
  return (
    <div
      className="card"
      style={{
        padding: 16,
        background: 'var(--peach-soft)',
        borderColor: 'oklch(90% 0.06 40)',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--peach-ink)' }}>Late penalty</div>
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--peach-ink)',
          marginTop: 2,
          opacity: 0.9,
        }}
      >
        {note}
      </div>
    </div>
  );
}
