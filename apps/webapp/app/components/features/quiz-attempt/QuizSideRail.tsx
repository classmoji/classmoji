import { ClockCircleOutlined } from '@ant-design/icons';
import { ExplorationStep, type ExplorationStepData } from './ExplorationStep';

interface QuizSideRailProps {
  isCodeAware?: boolean;
  steps?: ExplorationStepData[];
  proctorNote?: string;
}

/**
 * QuizSideRail — right column with instructions, live exploration log, and proctor note.
 * Ported from redesign bundle (screens.jsx:195-220).
 */
export function QuizSideRail({
  isCodeAware = false,
  steps = [],
  proctorNote = 'Focus time is tracked. Switching tabs or losing window focus reduces your focus score.',
}: QuizSideRailProps) {
  const visibleSteps = steps.slice(-5);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
      <div className="card" style={{ padding: 16 }}>
        <div className="caps" style={{ marginBottom: 8 }}>
          How this works
        </div>
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--ink-2)',
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          {isCodeAware
            ? 'Claude has read-only access to your repo. It references specific files and lines in questions — answer in your own words, it grades on reasoning, not keywords.'
            : 'Answer each question in your own words. Your responses are graded on reasoning, not keywords.'}
        </p>
      </div>

      {isCodeAware && (
        <div className="card" style={{ padding: 16 }}>
          <div className="caps" style={{ marginBottom: 8 }}>
            Live exploration
          </div>
          {visibleSteps.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              No files explored yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {visibleSteps.map((s, i) => (
                <ExplorationStep key={i} step={s} active />
              ))}
            </div>
          )}
        </div>
      )}

      <div
        className="card"
        style={{
          padding: 16,
          background: 'oklch(99% 0.02 230)',
          borderColor: 'oklch(92% 0.04 230)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--sky-ink)', display: 'inline-flex' }}>
            <ClockCircleOutlined style={{ fontSize: 14 }} />
          </span>
          <span className="caps" style={{ color: 'var(--sky-ink)' }}>
            Proctor
          </span>
        </div>
        <p
          style={{
            fontSize: 12,
            color: 'var(--sky-ink)',
            lineHeight: 1.5,
            margin: '6px 0 0',
            opacity: 0.9,
          }}
        >
          {proctorNote}
        </p>
      </div>
    </div>
  );
}

export default QuizSideRail;
