/**
 * The "it is now" marks on the week grid: a faint rule across the whole week, a
 * time badge in the gutter, and the accent line with a dot on today's column.
 *
 * All three are drawn only when today is one of the days on screen — the staff
 * grid drew the rule and the badge on EVERY week, so paging to next month put a
 * line through an arbitrary Tuesday at whatever time it happened to be. The
 * caller does that check once and renders none of these if it fails.
 *
 * Each piece is centred on the time (`translateY(-50%)`), not hung below it;
 * the student line was a half-line low against the same `top`.
 */

/**
 * `9:05`. No meridiem: the badge sits in a 4rem gutter, and "9:05 AM" at this
 * size does not fit — the hour rows around it already say which half of the day
 * this is.
 */
const badgeTime = (now: Date) =>
  `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')}`;

interface NowPieceProps {
  /** `topForHour(now)` — a CSS length from the top of the grid. */
  top: string;
}

/** The faint rule across all seven columns, behind the event blocks. */
export const NowRule = ({ top }: NowPieceProps) => (
  <div
    className="absolute left-0 right-0 pointer-events-none z-10"
    style={{ top, transform: 'translateY(-50%)' }}
  >
    <div className="h-px opacity-30" style={{ backgroundColor: 'var(--accent)' }} />
  </div>
);

interface NowBadgeProps extends NowPieceProps {
  now: Date;
}

/** The current time, in the hour gutter, in place of that hour's label. */
export const NowBadge = ({ now, top }: NowBadgeProps) => (
  <div
    className="absolute left-0.5 right-0.5 pointer-events-none z-20"
    style={{ top, transform: 'translateY(-50%)' }}
  >
    <div
      className="text-white text-xs font-medium px-1 py-0.5 rounded-full text-center"
      style={{ backgroundColor: 'var(--accent)' }}
    >
      {badgeTime(now)}
    </div>
  </div>
);

/** The solid line with a dot, on today's column only. */
export const NowMarker = ({ top }: NowPieceProps) => (
  <div
    className="absolute left-0 right-0 pointer-events-none z-20 flex items-center"
    style={{ top, transform: 'translateY(-50%)' }}
  >
    <div
      className="w-2.5 h-2.5 rounded-full -ml-1.5 shrink-0"
      style={{ backgroundColor: 'var(--accent)' }}
    />
    <div className="flex-1 h-0.5" style={{ backgroundColor: 'var(--accent)' }} />
  </div>
);
