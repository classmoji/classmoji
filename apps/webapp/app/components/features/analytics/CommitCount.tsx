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
  /** `sm` sits inline beside a link; `lg` fills a table column of its own. */
  size?: 'sm' | 'lg';
  className?: string;
}

/**
 * The number of commits in a student repo, beside its link. Reads the
 * analytics snapshot, so it is as fresh as the last refresh (the tooltip says
 * when) and renders nothing until a snapshot exists.
 *
 * A push refreshes the snapshot at most every 5 minutes, so the tooltip names
 * that cadence: a student who pushes and reloads immediately would otherwise
 * read an unchanged count as a bug.
 */
const CommitCount = ({ snapshot, href, size = 'sm', className = '' }: CommitCountProps) => {
  const n = snapshot?.total_commits;
  if (n === null || n === undefined) return null;
  const asOf = snapshot?.fetched_at ? dayjs(snapshot.fetched_at).format('MMM D, h:mm A') : null;
  const label = `${n} commit${n === 1 ? '' : 's'}${asOf ? ` · as of ${asOf}` : ''}`;
  const cadence = 'Updates within 5 minutes of a push';
  const large = size === 'lg';
  const body = (
    <>
      <IconGitCommit size={large ? 18 : 13} className="shrink-0 text-ink-3" />
      {n}
    </>
  );
  // antd's own `a { color: <link> }` reset is unlayered, so it outranks a
  // plain Tailwind text utility on an anchor and paints the count the theme's
  // link colour. The important modifier is what keeps it reading as text.
  const classes = `inline-flex items-center gap-1 tabular-nums ${
    large ? 'text-base text-ink-1!' : 'text-xs text-ink-3!'
  } ${className}`;
  return (
    <Tooltip
      title={
        <>
          <div>{href ? `${label} · open the latest commit` : label}</div>
          <div className="text-xs opacity-70">{cadence}</div>
        </>
      }
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          data-testid="commit-count"
          className={`${classes} hover:text-ink-1! hover:underline underline-offset-2`}
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
