interface QuizFooterProps {
  focusPercentage: number | null;
  progress: number; // 0..1
  elapsedMs?: number | null;
  timeLimitMs?: number | null;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * QuizFooter — Focused % + progress bar + timer.
 * Ported from redesign bundle (screens.jsx:183-192).
 */
export function QuizFooter({
  focusPercentage,
  progress,
  elapsedMs,
  timeLimitMs,
}: QuizFooterProps) {
  const pct = Math.max(0, Math.min(1, progress));
  const timer =
    elapsedMs != null
      ? timeLimitMs
        ? `${formatDuration(elapsedMs)} / ${formatDuration(timeLimitMs)}`
        : formatDuration(elapsedMs)
      : null;

  return (
    <div
      style={{
        padding: '10px 20px',
        borderTop: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
        Focused · {focusPercentage != null ? `${focusPercentage}%` : '—'}
      </span>
      <div
        style={{
          flex: 1,
          height: 4,
          background: 'var(--bg-3)',
          borderRadius: 99,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct * 100}%`,
            height: '100%',
            background: 'var(--violet)',
            transition: 'width 240ms ease',
          }}
        />
      </div>
      {timer && (
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
          {timer}
        </span>
      )}
    </div>
  );
}

export default QuizFooter;
