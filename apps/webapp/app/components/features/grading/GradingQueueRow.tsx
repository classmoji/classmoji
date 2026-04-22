import { IconChevronR } from '@classmoji/ui-components';
import {
  QueueAnomalyChips,
  type GitHubStatsSnapshot,
} from '~/components/features/analytics';

export interface GradingQueueItem {
  id: string;
  name: string;
  initials: string;
  hue: number;
  assignment: string;
  /** Human-readable relative time ("2h ago", "1d ago"). */
  submittedAt: string;
  /** Hours late, if late. `undefined` or 0 => not late. */
  lateHours?: number;
}

interface GradingQueueRowProps {
  item: GradingQueueItem;
  last?: boolean;
  onClick?: (id: string) => void;
  /** Optional analytics snapshot for this submission. */
  snapshot?: GitHubStatsSnapshot | null;
  /** ISO-8601 grader deadline, if any. */
  deadline?: string | null;
}

export function GradingQueueRow({
  item,
  last,
  onClick,
  snapshot,
  deadline,
}: GradingQueueRowProps) {
  const late = item.lateHours && item.lateHours > 0 ? item.lateHours : 0;
  return (
    <button
      type="button"
      className="row-hover"
      onClick={() => onClick?.(item.id)}
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 1fr 1fr 100px 40px',
        gap: 16,
        padding: '14px 18px',
        alignItems: 'center',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: 0,
        background: 'transparent',
        border: 'none',
        borderBottomWidth: last ? 0 : 1,
        borderBottomStyle: last ? 'none' : 'solid',
        borderBottomColor: last ? 'transparent' : 'var(--line)',
      }}
    >
      <span
        className="avatar"
        style={{
          background: `linear-gradient(135deg, oklch(80% 0.1 ${item.hue}), oklch(62% 0.18 ${item.hue}))`,
          width: 30,
          height: 30,
        }}
      >
        {item.initials}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{item.name}</span>
        {snapshot ? (
          <QueueAnomalyChips
            snapshot={snapshot}
            deadline={deadline ?? null}
          />
        ) : null}
      </div>
      <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{item.assignment}</span>
      <span
        className="mono"
        style={{
          fontSize: 12,
          color: late ? 'var(--rose-ink)' : 'var(--ink-3)',
        }}
      >
        {late ? `${late}h late` : item.submittedAt}
      </span>
      <span style={{ color: 'var(--ink-4)' }}>
        <IconChevronR size={14} />
      </span>
    </button>
  );
}

export default GradingQueueRow;
