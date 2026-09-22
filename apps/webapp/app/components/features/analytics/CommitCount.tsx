import { Tooltip } from 'antd';
import { IconGitCommit } from '@tabler/icons-react';
import dayjs from 'dayjs';

export interface CommitCountSnapshot {
  total_commits?: number | null;
  fetched_at?: string | Date | null;
}

interface CommitCountProps {
  /** The submission's analytics snapshot, when one has been fetched. */
  snapshot?: CommitCountSnapshot | null;
  className?: string;
}

/**
 * The number of commits in a student repo, beside its link. Reads the
 * analytics snapshot, so it is as fresh as the last refresh (the tooltip says
 * when) and renders nothing until a snapshot exists.
 */
const CommitCount = ({ snapshot, className = '' }: CommitCountProps) => {
  const n = snapshot?.total_commits;
  if (n === null || n === undefined) return null;
  const asOf = snapshot?.fetched_at ? dayjs(snapshot.fetched_at).format('MMM D, h:mm A') : null;
  return (
    <Tooltip title={`${n} commit${n === 1 ? '' : 's'}${asOf ? ` · as of ${asOf}` : ''}`}>
      <span
        data-testid="commit-count"
        className={`inline-flex items-center gap-0.5 text-xs tabular-nums text-ink-3 ${className}`}
      >
        <IconGitCommit size={13} className="shrink-0" />
        {n}
      </span>
    </Tooltip>
  );
};

export default CommitCount;
