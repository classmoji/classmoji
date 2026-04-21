import { Card } from 'antd';

interface MyDayHeaderProps {
  name: string;
  queueCount: number;
  medianSlaHours: number | null;
  streakDays: number;
  todayGraded: number;
  weekGraded: number;
  backlog: number;
}

const SLA_TARGET_HOURS = 24;

const firstNameOf = (fullName: string): string => {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return 'there';
  const first = trimmed.split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
};

const greetingFor = (now: Date = new Date()): string => {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

interface StatCellProps {
  label: string;
  value: string;
  sub?: string;
}

const StatCell = ({ label, value, sub }: StatCellProps) => (
  <div className="px-4 py-3 border-l first:border-l-0 border-gray-100 dark:border-gray-800">
    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
      {label}
    </div>
    <div className="mt-1 font-mono text-[22px] leading-tight text-gray-900 dark:text-gray-50 tabular-nums">
      {value}
    </div>
    {sub ? (
      <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{sub}</div>
    ) : null}
  </div>
);

const MyDayHeader = ({
  name,
  queueCount,
  medianSlaHours,
  streakDays,
  todayGraded,
  weekGraded,
  backlog,
}: MyDayHeaderProps) => {
  const firstName = firstNameOf(name);
  const greeting = greetingFor();
  const slaLabel =
    medianSlaHours === null
      ? 'No grades yet'
      : medianSlaHours <= SLA_TARGET_HOURS
        ? `SLA is on track — median ${medianSlaHours}h.`
        : `SLA is slipping — median ${medianSlaHours}h.`;
  const slaOnTrack = medianSlaHours !== null && medianSlaHours <= SLA_TARGET_HOURS;

  return (
    <Card
      className="mb-4 overflow-hidden"
      styles={{ body: { padding: 0 } }}
      data-testid="my-day-header"
    >
      <div
        className="flex items-start gap-4 p-5"
        style={{
          backgroundImage:
            'linear-gradient(135deg, var(--accent-soft), color-mix(in oklab, var(--accent-soft) 60%, transparent), transparent)',
        }}
      >
        <div className="flex-1 min-w-0">
          <h2 className="text-[24px] md:text-[26px] font-semibold leading-tight text-gray-900 dark:text-gray-50">
            {greeting}, {firstName}.
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            You have{' '}
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {queueCount} {queueCount === 1 ? 'submission' : 'submissions'}
            </span>{' '}
            in your queue.{' '}
            <span
              className={
                medianSlaHours === null
                  ? 'text-gray-500 dark:text-gray-400'
                  : slaOnTrack
                    ? 'font-medium text-emerald-600 dark:text-emerald-400'
                    : 'font-medium text-amber-600 dark:text-amber-400'
              }
            >
              {slaLabel}
            </span>
          </p>
        </div>
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/70 dark:bg-gray-900/40 text-sm font-medium text-gray-800 dark:text-gray-100 flex-shrink-0"
          style={{ boxShadow: 'inset 0 0 0 1px var(--accent-soft-2)' }}
          data-testid="streak-pill"
        >
          <span aria-hidden className="text-base leading-none">
            🔥
          </span>
          <span className="tabular-nums">
            {streakDays}-day{streakDays === 1 ? '' : ''} streak
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 border-t border-gray-100 dark:border-gray-800">
        <StatCell label="Graded today" value={String(todayGraded)} sub="since 00:00 UTC" />
        <StatCell label="This week" value={String(weekGraded)} sub="last 7 days" />
        <StatCell
          label="Median SLA"
          value={medianSlaHours === null ? '—' : `${medianSlaHours}h`}
          sub={`Target ${SLA_TARGET_HOURS}h`}
        />
        <StatCell label="Backlog" value={String(backlog)} sub="in your queue" />
      </div>
    </Card>
  );
};

export default MyDayHeader;
