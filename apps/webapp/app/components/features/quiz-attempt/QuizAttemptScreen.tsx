import type { ReactNode } from 'react';
import { CloseOutlined } from '@ant-design/icons';
import { QuizHeader } from './QuizHeader';
import { QuizFooter } from './QuizFooter';
import { QuizSideRail } from './QuizSideRail';
import type { ExplorationStepData } from './ExplorationStep';

interface QuizAttemptScreenProps {
  /** Short chip like "Quiz" or quiz number. */
  chipLabel: string;
  title: string;
  isCodeAware?: boolean;
  questionNumber?: number | null;
  questionTotal?: number | null;
  readOnly?: boolean;

  /** Focus percentage (0..100) computed from (total - unfocused) / total. */
  focusPercentage: number | null;
  /** 0..1 progress value for the bar. */
  progress: number;
  elapsedMs?: number | null;
  timeLimitMs?: number | null;

  /** Live exploration steps for the side rail log. */
  explorationSteps?: ExplorationStepData[];

  /** Main body content (message list, editor, evaluation, etc.). */
  children: ReactNode;

  /** Optional editor rendered below the scrollable body, inside the card. */
  editor?: ReactNode;

  onClose?: () => void;
}

/**
 * QuizAttemptScreen — full-page attempt shell with 2-col layout.
 *
 * Ported from redesign bundle (screens.jsx:37-223). This is the visual shell only —
 * the caller owns all quiz state, WebSocket wiring, and focus-metric hook usage.
 */
export function QuizAttemptScreen({
  chipLabel,
  title,
  isCodeAware = false,
  questionNumber,
  questionTotal,
  readOnly = false,
  focusPercentage,
  progress,
  elapsedMs,
  timeLimitMs,
  explorationSteps = [],
  children,
  editor,
  onClose,
}: QuizAttemptScreenProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--bg-1, #f7f7f9)',
        padding: 16,
        overflow: 'hidden',
      }}
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close quiz"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 2,
            width: 32,
            height: 32,
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'white',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink-2)',
          }}
        >
          <CloseOutlined />
        </button>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 340px',
          gap: 16,
          height: 'calc(100vh - 32px)',
        }}
      >
        {/* Main quiz card */}
        <div
          className="card"
          style={{
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          <QuizHeader
            chipLabel={chipLabel}
            title={title}
            isCodeAware={isCodeAware}
            questionNumber={questionNumber}
            questionTotal={questionTotal}
            readOnly={readOnly}
          />

          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            {children}
          </div>

          {editor && (
            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--line)',
                background: 'white',
              }}
            >
              {editor}
            </div>
          )}

          <QuizFooter
            focusPercentage={focusPercentage}
            progress={progress}
            elapsedMs={elapsedMs}
            timeLimitMs={timeLimitMs}
          />
        </div>

        {/* Side rail */}
        <QuizSideRail isCodeAware={isCodeAware} steps={explorationSteps} />
      </div>
    </div>
  );
}

export default QuizAttemptScreen;
