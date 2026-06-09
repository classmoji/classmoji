import { Tag } from 'antd';
import {
  lateCommitRatio,
  isMegaCommit,
  averageCommitQuality,
  busFactor,
  dumpAndRun,
} from '@classmoji/services/flags';
import type { CommitRecord } from './CommitTimeline';
import type { ContributorRecord } from './GitHubStatsPanel';

export interface AnomaliesProps {
  snapshot: {
    commits: CommitRecord[];
    contributors: ContributorRecord[];
    total_additions: number;
    total_deletions: number;
  };
  deadline: string | null;
}

/**
 * Compact anomaly chips computed from a repo analytics snapshot.
 * Pure client-side — all heuristics are imported from @classmoji/services
 * (which only depends on types). Returns null when no flags fire.
 */
const Anomalies = ({ snapshot, deadline }: AnomaliesProps) => {
  const { commits, contributors, total_additions, total_deletions } = snapshot;
  const deadlineDate = deadline ? new Date(deadline) : null;

  const chips: React.ReactNode[] = [];

  // Late commits
  const lateRatio = lateCommitRatio(commits, deadlineDate);
  if (lateRatio > 0.3) {
    chips.push(
      <Tag key="late" color="red" data-testid="anomaly-late" className="dark:border-red-800">
        Late commits {(lateRatio * 100).toFixed(0)}%
      </Tag>
    );
  }

  // Mega commit (first one we find)
  const mega = commits.find(c => isMegaCommit(c, total_additions, total_deletions));
  if (mega) {
    chips.push(
      <Tag key="mega" color="orange" data-testid="anomaly-mega" className="dark:border-orange-800">
        Mega commit {mega.sha.slice(0, 7)}
      </Tag>
    );
  }

  // Dump and run
  if (dumpAndRun(commits, deadlineDate)) {
    chips.push(
      <Tag key="dump" color="red" data-testid="anomaly-dump" className="dark:border-red-800">
        Dump-and-run
      </Tag>
    );
  }

  // Bus factor
  const bus = busFactor(contributors);
  if (bus && bus.share > 0.7) {
    chips.push(
      <Tag key="bus" color="gold" data-testid="anomaly-bus" className="dark:border-yellow-800">
        Bus factor · {bus.login} {(bus.share * 100).toFixed(0)}%
      </Tag>
    );
  }

  // Weak messages
  if (commits.length > 3) {
    const quality = averageCommitQuality(commits);
    if (quality < 0.3) {
      chips.push(
        <Tag key="weak" color="default" data-testid="anomaly-weak" className="dark:border-gray-700">
          Weak messages
        </Tag>
      );
    }
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-6" data-testid="anomaly-chips">
      {chips}
    </div>
  );
};

export default Anomalies;
