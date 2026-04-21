import type { CommitRecord } from './CommitTimeline';
import type { ContributorRecord } from './GitHubStatsPanel';
import { loginToColor } from './ContributorBreakdown';

export interface BraidTimelineProps {
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  deadline?: string | null;
}

const ROW_HEIGHT = 40;
const LEFT_COL_PX = 140;
const RIGHT_COL_PX = 56;
const DOT_RADIUS = 5;

function firstName(login: string): string {
  return login.split(/[-_. ]/)[0] || login;
}

/**
 * Per-contributor horizontal swim lanes showing commit timestamps as dots
 * along a shared time axis. A vertical red rule marks the deadline.
 */
const BraidTimeline = ({
  commits,
  contributors,
  deadline,
}: BraidTimelineProps) => {
  const sortedContribs = [...contributors].sort((a, b) => b.commits - a.commits);

  if (sortedContribs.length === 0 || commits.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 text-sm"
        style={{ height: 120 }}
        data-testid="braid-timeline-empty"
      >
        No commit activity
      </div>
    );
  }

  // Time bounds
  const timestamps = commits
    .map((c) => new Date(c.ts).getTime())
    .filter((t) => Number.isFinite(t));
  const minT = Math.min(...timestamps);
  const maxT = Math.max(...timestamps);
  const span = Math.max(1, maxT - minT);

  const deadlineT = deadline ? new Date(deadline).getTime() : null;

  // Track dimensions
  const height = Math.max(ROW_HEIGHT, sortedContribs.length * ROW_HEIGHT);

  const xFor = (t: number, trackWidthPct: number): string => {
    const pct = ((t - minT) / span) * trackWidthPct;
    return `${Math.max(0, Math.min(trackWidthPct, pct))}%`;
  };

  // Percent within the track (which is the middle column)
  const deadlinePct =
    deadlineT !== null
      ? Math.max(0, Math.min(100, ((deadlineT - minT) / span) * 100))
      : null;

  return (
    <div data-testid="braid-timeline">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
        Commit braid
      </div>
      <div
        className="relative rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900"
        style={{
          height,
          paddingLeft: LEFT_COL_PX,
          paddingRight: RIGHT_COL_PX,
        }}
      >
        {/* Deadline rule — positioned within the track area */}
        {deadlinePct !== null && (
          <div
            className="absolute top-0 bottom-0 border-l-2 border-dashed border-red-500"
            style={{
              left: `calc(${LEFT_COL_PX}px + ${deadlinePct}% * (100% - ${LEFT_COL_PX + RIGHT_COL_PX}px) / 100)`,
            }}
            data-testid="braid-deadline"
          />
        )}

        {sortedContribs.map((c, idx) => {
          const color = loginToColor(c.login);
          const laneCommits = commits.filter((co) => co.author_login === c.login);
          return (
            <div
              key={c.login}
              className="absolute left-0 right-0 flex items-center"
              style={{
                top: idx * ROW_HEIGHT,
                height: ROW_HEIGHT,
              }}
              data-testid={`braid-lane-${c.login}`}
            >
              {/* Left label */}
              <div
                className="absolute left-0 flex items-center gap-2 px-3 text-xs"
                style={{ width: LEFT_COL_PX }}
              >
                <span
                  className="inline-block h-5 w-5 rounded-full text-[10px] font-semibold text-white flex items-center justify-center shrink-0"
                  style={{ backgroundColor: color }}
                >
                  {firstName(c.login).charAt(0).toUpperCase()}
                </span>
                <span className="truncate font-medium text-gray-800 dark:text-gray-100">
                  {firstName(c.login)}
                </span>
              </div>

              {/* Track */}
              <div
                className="absolute top-1/2 -translate-y-px border-t border-gray-100 dark:border-gray-800"
                style={{
                  left: LEFT_COL_PX,
                  right: RIGHT_COL_PX,
                }}
              />
              <div
                className="absolute"
                style={{
                  left: LEFT_COL_PX,
                  right: RIGHT_COL_PX,
                  top: 0,
                  bottom: 0,
                }}
              >
                {laneCommits.map((co) => {
                  const t = new Date(co.ts).getTime();
                  if (!Number.isFinite(t)) return null;
                  return (
                    <span
                      key={co.sha}
                      title={`${co.message} — ${new Date(co.ts).toLocaleString()}`}
                      className="absolute rounded-full"
                      style={{
                        left: xFor(t, 100),
                        top: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: DOT_RADIUS * 2,
                        height: DOT_RADIUS * 2,
                        backgroundColor: color,
                      }}
                    />
                  );
                })}
              </div>

              {/* Right count */}
              <div
                className="absolute right-0 px-3 text-xs tabular-nums text-gray-600 dark:text-gray-300"
                style={{ width: RIGHT_COL_PX, textAlign: 'right' }}
              >
                {c.commits}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default BraidTimeline;
