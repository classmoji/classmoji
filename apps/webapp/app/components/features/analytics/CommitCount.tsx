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
  /** Where the chip goes when clicked (the newest commit, or the commit list). */
  href?: string | null;
  className?: string;
}

/**
 * The number of commits in a student repo, beside its link. Reads the
 * analytics snapshot, so it is as fresh as the last refresh (the tooltip says
 * when) and renders nothing until a snapshot exists.
 */
const CommitCount = ({ snapshot, href, className = '' }: CommitCountProps) => {
  const n = snapshot?.total_commits;
  if (n === null || n === undefined) return null;
  const asOf = snapshot?.fetched_at ? dayjs(snapshot.fetched_at).format('MMM D, h:mm A') : null;
  const label = `${n} commit${n === 1 ? '' : 's'}${asOf ? ` · as of ${asOf}` : ''}`;
  const body = (
    <>
      <IconGitCommit size={13} className="shrink-0" />
      {n}
    </>
  );
  const classes = `inline-flex items-center gap-0.5 text-xs tabular-nums text-ink-3 ${className}`;
  return (
    <Tooltip title={href ? `${label} · open the latest commit` : label}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          data-testid="commit-count"
          className={`${classes} hover:text-ink-1 hover:underline underline-offset-2`}
        >
          {body}
        </a>
      ) : (
        <span data-testid="commit-count" className={classes}>
          {body}
        </span>
      )}
    </Tooltip>
  );
};

export default CommitCount;
