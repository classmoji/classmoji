import type { ReactNode } from 'react';

interface QuizHeaderProps {
  chipLabel: string;
  title: string;
  isCodeAware?: boolean;
  questionNumber?: number | null;
  questionTotal?: number | null;
  readOnly?: boolean;
  extra?: ReactNode;
}

/**
 * QuizHeader — sticky top row for the attempt card.
 * Ported from redesign bundle (screens.jsx:62-79).
 */
export function QuizHeader({
  chipLabel,
  title,
  isCodeAware = false,
  questionNumber,
  questionTotal,
  readOnly = false,
  extra,
}: QuizHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '16px 20px',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span className="chip chip-quiz">{chipLabel}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>{title}</span>
      {readOnly && (
        <span className="chip chip-ghost" style={{ marginLeft: 4 }}>
          Completed
        </span>
      )}
      <div style={{ flex: 1 }} />
      {isCodeAware && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px',
            borderRadius: 99,
            background: 'var(--mint-soft)',
            color: 'var(--mint-ink)',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          <span
            className="dot pulse-dot"
            style={{ background: 'oklch(55% 0.15 155)' }}
          />
          Code-aware mode
        </span>
      )}
      {questionNumber != null && questionTotal != null && questionTotal > 0 && (
        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          Q {questionNumber}/{questionTotal}
        </span>
      )}
      {extra}
    </div>
  );
}

export default QuizHeader;
