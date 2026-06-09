import { Tag } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { calculateRepositoryGrade } from '@classmoji/utils';
import { GradeBadge } from '~/components';

dayjs.extend(relativeTime);

interface CardProps {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}

const Card = ({ title, extra, children }: CardProps) => (
  <div className="bg-white dark:bg-neutral-900 p-6 rounded-2xl ring-1 ring-stone-200 dark:ring-neutral-800">
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-semibold text-ink-1">{title}</h3>
      {extra}
    </div>
    <div className="divide-y divide-stone-100 dark:divide-neutral-800">{children}</div>
  </div>
);

const StatItem = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-center justify-between py-2.5">
    <span className="text-ink-2">{label}</span>
    <span className="font-semibold text-ink-0">{value}</span>
  </div>
);

interface RepoAssignment {
  status: string;
  is_late_override?: boolean;
  closed_at?: string | Date | null;
  grades?: unknown[];
  [key: string]: unknown;
}

interface Repo {
  assignments?: RepoAssignment[];
  [key: string]: unknown;
}

interface RepositoryAssignment {
  id: string;
  student_deadline?: string | Date | null;
}

interface RepositoryData {
  type: string;
  weight: number;
  is_published: boolean;
  is_extra_credit?: boolean;
  drop_lowest_count?: number;
  assignments?: RepositoryAssignment[];
}

interface SummaryCardsProps {
  repository: RepositoryData;
  repos: Repo[];
  studentsCount: number;
  teamsCount: number;
  emojiMappings: Parameters<typeof calculateRepositoryGrade>[1];
  settings: Parameters<typeof calculateRepositoryGrade>[2];
}

const SummaryCards = ({
  repository,
  repos,
  studentsCount,
  teamsCount,
  emojiMappings,
  settings,
}: SummaryCardsProps) => {
  const assignments = repository.assignments || [];
  // In the current model the "repositories" of a coursework unit are the
  // per-student / per-team GitRepo instances, i.e. the loader's `repos`.
  const repoCount = repos.length;

  // Earliest assignment deadline = repository "due date"
  const deadlines = assignments
    .map(a => (a.student_deadline ? dayjs(a.student_deadline) : null))
    .filter((d): d is dayjs.Dayjs => !!d && d.isValid());
  const earliestDeadline = deadlines.length
    ? deadlines.reduce((min, d) => (d.isBefore(min) ? d : min))
    : null;

  // Submission stats from GitRepoAssignment rows
  let totalSubmissions = 0;
  let onTime = 0;
  let lateOrMissing = 0;
  let lastActivity: dayjs.Dayjs | null = null;
  for (const repo of repos) {
    for (const ra of repo.assignments || []) {
      if (ra.status === 'CLOSED') {
        totalSubmissions += 1;
        if (!ra.is_late_override) onTime += 1;
        else lateOrMissing += 1;
      } else if (ra.is_late_override) {
        lateOrMissing += 1;
      }
      if (ra.closed_at) {
        const closed = dayjs(ra.closed_at);
        if (closed.isValid() && (!lastActivity || closed.isAfter(lastActivity))) {
          lastActivity = closed;
        }
      }
    }
  }

  // Average grade across repos that have a computable grade
  const repositoryGradeConfig = {
    is_extra_credit: repository.is_extra_credit ?? false,
    drop_lowest_count: repository.drop_lowest_count ?? 0,
    weight: 0,
  };
  const grades = repos
    .map(repo =>
      calculateRepositoryGrade(
        (repo.assignments || []) as unknown as Parameters<typeof calculateRepositoryGrade>[0],
        emojiMappings,
        settings,
        repositoryGradeConfig as unknown as Parameters<typeof calculateRepositoryGrade>[3]
      )
    )
    .filter(g => g >= 0);
  const averageGrade = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <Card
        title="Repository overview"
        extra={
          <Tag color={repository.is_published ? 'green' : 'orange'} className="font-semibold">
            {repository.is_published ? 'Published' : 'Draft'}
          </Tag>
        }
      >
        <StatItem
          label="Type"
          value={
            <Tag color={repository.type === 'GROUP' ? 'blue' : 'orange'} className="m-0">
              {repository.type}
            </Tag>
          }
        />
        <StatItem label="Weight" value={`${repository.weight}%`} />
        <StatItem label="Repositories" value={repoCount} />
        <StatItem
          label="Due date"
          value={earliestDeadline ? earliestDeadline.format('MMM D, YYYY') : '—'}
        />
      </Card>

      <Card title="Assignments overview">
        <StatItem label="Number of assignments" value={assignments.length} />
        <StatItem label="Total submissions" value={totalSubmissions} />
        <StatItem
          label="Submitted on time"
          value={<span className="text-green-600 dark:text-green-400">{onTime}</span>}
        />
        <StatItem
          label="Late / missing"
          value={
            <span className={lateOrMissing > 0 ? 'text-rose-600 dark:text-rose-400' : ''}>
              {lateOrMissing}
            </span>
          }
        />
      </Card>

      <Card title="Class snapshot">
        <StatItem label="Students enrolled" value={studentsCount} />
        <StatItem label="Teams" value={teamsCount} />
        <StatItem
          label="Average grade"
          value={averageGrade !== null ? <GradeBadge grade={averageGrade} /> : '—'}
        />
        <StatItem label="Last activity" value={lastActivity ? lastActivity.fromNow() : '—'} />
      </Card>
    </div>
  );
};

export default SummaryCards;
