import { Popover, Tooltip } from 'antd';
import dayjs from 'dayjs';
import {
  lineShare,
  type RepoContributionAuthor,
  type RepoContributions,
} from '@classmoji/utils/repo-contributions';

export type ContributorNames = Record<string, { name: string | null; login: string | null }>;

/** Flat fills, one per author in order; the rest share the last one. */
const SEGMENT_COLORS = [
  'bg-sky-500 dark:bg-sky-400',
  'bg-amber-500 dark:bg-amber-400',
  'bg-emerald-500 dark:bg-emerald-400',
  'bg-violet-500 dark:bg-violet-400',
  'bg-rose-500 dark:bg-rose-400',
];
const OTHER_COLOR = 'bg-gray-400 dark:bg-neutral-500';
const colorFor = (i: number) => SEGMENT_COLORS[i] ?? OTHER_COLOR;

const shortDate = (iso: string | null) => (iso ? dayjs(iso).format('MMM D') : null);

/** The Classmoji name when the author matched a member, else the git name. */
function displayName(author: RepoContributionAuthor, names: ContributorNames) {
  const member = author.user_id ? names[author.user_id] : undefined;
  return {
    name: member?.name || member?.login || author.git_name,
    login: member?.login ?? null,
    matched: Boolean(member),
  };
}

function activeRange(author: RepoContributionAuthor) {
  const first = shortDate(author.first_commit_at);
  const last = shortDate(author.last_commit_at);
  if (!first || !last) return '—';
  return first === last ? first : `${first} to ${last}`;
}

function Details({
  stats,
  names,
  calculatedAt,
}: {
  stats: RepoContributions;
  names: ContributorNames;
  calculatedAt: string | Date | null;
}) {
  return (
    <div className="w-[34rem] max-w-[90vw] text-sm">
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="pb-2 font-medium">Contributor</th>
            <th className="pb-2 font-medium text-right">Lines</th>
            <th className="pb-2 font-medium text-right">Commits</th>
            <th className="pb-2 font-medium text-right">+ / −</th>
            <th className="pb-2 pl-3 font-medium">Active</th>
          </tr>
        </thead>
        <tbody>
          {stats.authors.map((author, i) => {
            const who = displayName(author, names);
            return (
              <tr
                key={`${author.user_id ?? author.git_email ?? author.git_name}-${i}`}
                className="border-t border-stone-100 dark:border-neutral-800"
              >
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`size-2.5 shrink-0 rounded-full ${colorFor(i)}`} />
                    <div className="min-w-0">
                      <div className="truncate text-ink-1">{who.name}</div>
                      <div className="truncate text-xs text-ink-3">
                        {who.matched
                          ? (who.login ?? author.git_email)
                          : `Not matched: ${author.git_email ?? author.git_name}`}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="py-1.5 text-right tabular-nums text-ink-1">
                  {lineShare(author, stats.total_lines)}%
                  <span className="ml-1 text-xs text-ink-3">({author.lines})</span>
                </td>
                <td className="py-1.5 text-right tabular-nums text-ink-1">{author.commits}</td>
                <td className="py-1.5 text-right tabular-nums text-xs">
                  <span className="text-emerald-600 dark:text-emerald-400">
                    +{author.additions}
                  </span>{' '}
                  <span className="text-rose-600 dark:text-rose-400">−{author.deletions}</span>
                </td>
                <td className="py-1.5 pl-3 text-ink-2 whitespace-nowrap">{activeRange(author)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-3 space-y-0.5 text-xs text-ink-3">
        <div>
          Lines are the current code by who last changed each line. Starter code still unchanged:{' '}
          {stats.starter_lines} lines, credited to no one.
        </div>
        {stats.files_skipped > 0 && (
          <div>{stats.files_skipped} large or extra files were not counted.</div>
        )}
        {calculatedAt && (
          <div>
            Calculated {dayjs(calculatedAt).format('MMM D, YYYY h:mm A')}
            {stats.head_sha ? ` at commit ${stats.head_sha.slice(0, 7)}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One team repo's contributions: a share bar and the top authors, with the
 * full table (lines, commits, active dates) on click.
 */
export default function ContributionsCell({
  stats,
  error,
  calculatedAt,
  names,
}: {
  stats: RepoContributions | null;
  error: string | null;
  calculatedAt: string | Date | null;
  names: ContributorNames;
}) {
  const when = calculatedAt ? dayjs(calculatedAt).format('MMM D, h:mm A') : null;

  if (error) {
    return (
      <Tooltip title={error}>
        <div className="text-sm">
          <span className="text-rose-600 dark:text-rose-400">Calculation failed</span>
          {when && <div className="text-xs text-ink-3">{when}</div>}
        </div>
      </Tooltip>
    );
  }
  if (!stats) return <span className="text-sm text-ink-3">Not calculated</span>;
  if (stats.authors.length === 0) {
    return (
      <div className="text-sm text-ink-3">
        No commits from students yet
        {when && <div className="text-xs">Calculated {when}</div>}
      </div>
    );
  }

  const top = stats.authors.slice(0, 3);
  const more = stats.authors.length - top.length;

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title="Contributions"
      content={<Details stats={stats} names={names} calculatedAt={calculatedAt} />}
    >
      <button type="button" className="block w-full text-left cursor-pointer group">
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-neutral-800">
          {stats.authors.map((author, i) => {
            const share = lineShare(author, stats.total_lines);
            return share > 0 ? (
              <div key={i} className={colorFor(i)} style={{ width: `${share}%` }} />
            ) : null;
          })}
        </div>
        <div className="mt-1.5 flex flex-col gap-0.5 text-xs">
          {top.map((author, i) => (
            <span key={i} className="flex items-center gap-1.5 min-w-0 text-ink-2">
              <span className={`size-2 shrink-0 rounded-full ${colorFor(i)}`} />
              <span className="truncate group-hover:underline underline-offset-2">
                {displayName(author, names).name}
              </span>
              <span className="ml-auto shrink-0 tabular-nums text-ink-3">
                {lineShare(author, stats.total_lines)}% · {author.commits}{' '}
                {author.commits === 1 ? 'commit' : 'commits'}
              </span>
            </span>
          ))}
          {more > 0 && <span className="text-ink-3">+{more} more</span>}
        </div>
        {when && <div className="mt-0.5 text-[11px] text-ink-3">Calculated {when}</div>}
      </button>
    </Popover>
  );
}
