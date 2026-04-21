import { Tag } from 'antd';
import {
  lateCommitRatio,
  busFactor,
  dumpAndRun,
} from '@classmoji/services/flags';
import type { CommitRecord } from './CommitTimeline';
import type { ContributorRecord } from './GitHubStatsPanel';

export interface QueueAnomalyChipsProps {
  snapshot: {
    commits: CommitRecord[];
    contributors: ContributorRecord[];
    total_additions: number;
    total_deletions: number;
  };
  deadline: string | null;
}

/**
 * Ultra-compact anomaly chips for the grading queue list view.
 * Surfaces only the highest-signal flags (late commits > 30%,
 * dump-and-run, bus factor > 70%) so TAs can triage at-a-glance
 * without expanding each row. Returns null when nothing fires.
 *
 * For the full chip strip (including mega commits and weak
 * messages), use <Anomalies> in the expanded detail panel.
 */
const QueueAnomalyChips = ({ snapshot, deadline }: QueueAnomalyChipsProps) => {
  const { commits, contributors } = snapshot;
  const deadlineDate = deadline ? new Date(deadline) : null;

  const chips: React.ReactNode[] = [];

  const lateRatio = lateCommitRatio(commits, deadlineDate);
  if (lateRatio > 0.3) {
    chips.push(
      <Tag
        key="late"
        color="red"
        data-testid="queue-anomaly-late"
        className="dark:border-red-800"
        style={{ fontSize: 11, lineHeight: '16px', padding: '0 6px', margin: 0 }}
      >
        Late {(lateRatio * 100).toFixed(0)}%
      </Tag>
    );
  }

  if (dumpAndRun(commits, deadlineDate)) {
    chips.push(
      <Tag
        key="dump"
        color="red"
        data-testid="queue-anomaly-dump"
        className="dark:border-red-800"
        style={{ fontSize: 11, lineHeight: '16px', padding: '0 6px', margin: 0 }}
      >
        Dump-and-run
      </Tag>
    );
  }

  const bus = busFactor(contributors);
  if (bus && bus.share > 0.7) {
    chips.push(
      <Tag
        key="bus"
        color="gold"
        data-testid="queue-anomaly-bus"
        className="dark:border-yellow-800"
        style={{ fontSize: 11, lineHeight: '16px', padding: '0 6px', margin: 0 }}
      >
        Bus {(bus.share * 100).toFixed(0)}%
      </Tag>
    );
  }

  if (chips.length === 0) return null;

  return (
    <div
      data-testid="queue-anomaly-chips"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
    >
      {chips}
    </div>
  );
};

export default QueueAnomalyChips;
