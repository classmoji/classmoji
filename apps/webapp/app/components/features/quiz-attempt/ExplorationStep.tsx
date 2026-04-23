/**
 * ExplorationStep — single animated row in the "Live exploration" panel.
 * Ported from redesign bundle (screens.jsx:8-35).
 */
export type ExplorationStepKind = 'read' | 'grep' | 'glob' | string;

export interface ExplorationStepData {
  kind: ExplorationStepKind;
  path: string;
  detail?: string;
}

interface ExplorationStepProps {
  step: ExplorationStepData;
  active?: boolean;
}

const KIND_COLORS: Record<string, { color: string; bg: string }> = {
  read: { color: 'oklch(62% 0.15 230)', bg: 'oklch(96% 0.03 230)' },
  grep: { color: 'oklch(62% 0.15 285)', bg: 'oklch(96% 0.03 285)' },
  glob: { color: 'oklch(62% 0.15 40)', bg: 'oklch(96% 0.03 40)' },
};

export function ExplorationStep({ step, active = true }: ExplorationStepProps) {
  const palette = KIND_COLORS[step.kind] ?? KIND_COLORS.read;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 8,
        background: active ? 'rgba(255,255,255,0.9)' : 'transparent',
        border: active ? '1px solid var(--line)' : '1px solid transparent',
        opacity: active ? 1 : 0.55,
        transition: 'all 200ms',
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 10,
          fontWeight: 700,
          background: palette.bg,
          color: palette.color,
          padding: '2px 6px',
          borderRadius: 4,
          minWidth: 36,
          textAlign: 'center',
        }}
      >
        {step.kind}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: 'var(--ink-1)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={step.path}
      >
        {step.path}
      </span>
      {step.detail && (
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
          {step.detail}
        </span>
      )}
    </div>
  );
}

export default ExplorationStep;
