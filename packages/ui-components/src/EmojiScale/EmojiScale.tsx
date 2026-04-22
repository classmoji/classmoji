export interface EmojiGrade {
  emoji: string;
  pct: number;
  label: string;
}

export interface EmojiScaleProps {
  grades: EmojiGrade[];
  picked?: { emoji: string } | null;
  onPick: (grade: EmojiGrade) => void;
}

/**
 * Ported from the redesign bundle (assignments.jsx:124-151).
 */
export function EmojiScale({ grades, picked, onPick }: EmojiScaleProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        background: 'var(--bg-3)',
        borderRadius: 12,
      }}
    >
      {grades.map((g) => {
        const active = picked?.emoji === g.emoji;
        return (
          <button
            key={g.emoji}
            type="button"
            onClick={() => onPick(g)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              padding: '8px 10px',
              borderRadius: 8,
              background: active ? 'white' : 'transparent',
              boxShadow: active ? 'var(--shadow-md)' : 'none',
              transform: active ? 'translateY(-2px) scale(1.04)' : '',
              transition: 'all 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
              cursor: 'pointer',
              minWidth: 56,
            }}
          >
            <span style={{ fontSize: 22, lineHeight: 1 }}>{g.emoji}</span>
            <span
              style={{ fontSize: 10, color: 'var(--ink-3)', fontWeight: 600 }}
              className="mono"
            >
              {g.pct}
            </span>
          </button>
        );
      })}
    </div>
  );
}
