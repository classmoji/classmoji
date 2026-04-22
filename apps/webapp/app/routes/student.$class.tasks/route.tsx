import { useMemo, useState } from 'react';
import { Link, useFetcher, useRevalidator } from 'react-router';
import dayjs from 'dayjs';
import { IconChevronRight } from '@tabler/icons-react';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';

// --- Types -----------------------------------------------------------------

type TaskKind = 'asgn' | 'quiz';
type TaskStatus = 'open' | 'submitted' | 'late' | 'done' | 'upcoming' | 'locked';

interface GradeChip {
  emoji: string;
  graderName: string | null;
  grade: number | null;
}

interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  dueAt: Date | null;
  status: TaskStatus;
  moduleTitle?: string;
  href: string;
  // Richer metadata used to render grade chips + action buttons.
  repositoryAssignmentId?: string;
  assignmentId?: string;
  grades?: GradeChip[];
  isLate?: boolean;
  isLateOverride?: boolean;
  tokensPerHour?: number;
}

interface LoaderRepoAssignment {
  id: string;
  status: string;
  provider_issue_number?: number | null;
  is_late_override?: boolean;
  assignment: {
    id: string;
    title: string;
    student_deadline: string | Date | null;
    tokens_per_hour?: number | null;
  };
  repository: {
    name: string;
    module: { id: string; title: string; slug: string | null } | null;
  };
  grades?: Array<{
    emoji: string;
    grader?: { name?: string | null } | null;
  }>;
}

interface LoaderQuiz {
  id: string;
  name: string;
  due_date: string | Date | null;
  status: string;
  module: { id: string; title: string } | null;
  attempts?: Array<{ status?: string; completed_at?: string | Date | null }>;
}

// --- Loader ----------------------------------------------------------------

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_TASKS',
    attemptedAction: 'view_tasks',
  });

  const [rawRepoAssignments, rawQuizzes, rawEmojiMappings, balance] = (await Promise.all([
    ClassmojiService.repositoryAssignment.findForUser({
      repository: { student_id: userId, classroom_id: classroom.id },
    }),
    ClassmojiService.quiz.getQuizzesForStudent(classroom.id, userId, membership),
    // findByClassroomId (default) returns Record<emoji, grade>, not an array.
    ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    ClassmojiService.token.getBalance(classroom.id, userId),
  ])) as unknown as [
    LoaderRepoAssignment[],
    LoaderQuiz[],
    Record<string, number>,
    number,
  ];

  const emojiGrade = new Map<string, number>(Object.entries(rawEmojiMappings ?? {}));
  const now = dayjs();
  const tasks: Task[] = [];

  for (const ra of rawRepoAssignments ?? []) {
    const due = ra.assignment?.student_deadline
      ? new Date(ra.assignment.student_deadline as string | Date)
      : null;
    let status: TaskStatus;
    if (ra.status === 'CLOSED') status = 'done';
    else if (ra.status === 'SUBMITTED') status = 'submitted';
    else if (due && dayjs(due).isBefore(now)) status = 'late';
    else if (due && dayjs(due).diff(now, 'day') > 7) status = 'upcoming';
    else status = 'open';

    const grades: GradeChip[] = (ra.grades ?? []).map(g => ({
      emoji: g.emoji,
      graderName: g.grader?.name ?? null,
      grade: emojiGrade.get(g.emoji) ?? null,
    }));
    const isLate = Boolean(due && dayjs(due).isBefore(now));
    const isLateOverride = Boolean(ra.is_late_override);

    tasks.push({
      id: `asgn-${ra.id}`,
      kind: 'asgn',
      title: ra.assignment.title,
      dueAt: due,
      status,
      moduleTitle: ra.repository.module?.title,
      href: ra.repository.module?.slug
        ? `/student/${classSlug}/modules/${ra.repository.module.slug}`
        : `/student/${classSlug}/modules`,
      repositoryAssignmentId: ra.id,
      assignmentId: ra.assignment.id,
      grades,
      isLate,
      isLateOverride,
      tokensPerHour: ra.assignment.tokens_per_hour ?? 0,
    });
  }

  for (const q of rawQuizzes ?? []) {
    const due = q.due_date ? new Date(q.due_date as string | Date) : null;
    const completed = (q.attempts ?? []).some(a => a.status === 'completed');
    let status: TaskStatus;
    if (completed) status = 'done';
    else if (q.status !== 'PUBLISHED') status = 'locked';
    else if (due && dayjs(due).isBefore(now)) status = 'late';
    else if (due && dayjs(due).diff(now, 'day') > 7) status = 'upcoming';
    else status = 'open';

    tasks.push({
      id: `quiz-${q.id}`,
      kind: 'quiz',
      title: q.name,
      dueAt: due,
      status,
      moduleTitle: q.module?.title,
      href: `/student/${classSlug}/quizzes/${q.id}`,
    });
  }

  return { classSlug, tasks, tokenBalance: balance };
};

// --- Helpers ---------------------------------------------------------------

const STATUS_FILTERS: Array<{ key: 'all' | TaskStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'late', label: 'Late' },
  { key: 'done', label: 'Done' },
  { key: 'upcoming', label: 'Upcoming' },
];

const TYPE_FILTERS: Array<{ key: 'all' | TaskKind; label: string }> = [
  { key: 'all', label: 'All types' },
  { key: 'quiz', label: 'Quizzes' },
  { key: 'asgn', label: 'Assignments' },
];

const STATUS_CHIP: Record<TaskStatus, { className: string; label: string }> = {
  open: { className: 'chip-inprog', label: 'Open' },
  submitted: { className: 'chip-submitted', label: 'Submitted' },
  late: { className: 'chip-late', label: 'Late' },
  done: { className: 'chip-done', label: 'Done' },
  upcoming: { className: 'chip-upcoming', label: 'Upcoming' },
  locked: { className: 'chip-locked', label: 'Locked' },
};

type Bucket = 'overdue' | 'today' | 'week' | 'later' | 'undated';
const BUCKET_ORDER: Bucket[] = ['overdue', 'today', 'week', 'later', 'undated'];
const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
  undated: 'No due date',
};

function bucketFor(dueAt: Date | null, now = dayjs()): Bucket {
  if (!dueAt) return 'undated';
  const d = dayjs(dueAt);
  if (d.isBefore(now, 'day')) return 'overdue';
  if (d.isSame(now, 'day')) return 'today';
  if (d.diff(now, 'day') < 7) return 'week';
  return 'later';
}

function relativeDue(dueAt: Date | null, now = dayjs()): string {
  if (!dueAt) return 'No due date';
  const d = dayjs(dueAt);
  const days = d.startOf('day').diff(now.startOf('day'), 'day');
  if (days === 0) return `Due today · ${d.format('h:mm A')}`;
  if (days === 1) return `Due tomorrow · ${d.format('h:mm A')}`;
  if (days === -1) return `Due yesterday · ${d.format('h:mm A')}`;
  if (days < 0) return `Due ${Math.abs(days)}d ago · ${d.format('MMM D')}`;
  if (days < 7) return `Due ${d.format('ddd h:mm A')}`;
  return `Due ${d.format('MMM D')}`;
}

// --- Component -------------------------------------------------------------

const StudentTasks = ({ loaderData }: Route.ComponentProps) => {
  const { tasks, tokenBalance, classSlug } = loaderData;
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | TaskKind>('all');
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();

  const onBuyExtension = (repositoryAssignmentId: string, tokensPerHour: number) => {
    if (tokensPerHour <= 0) return;
    const hoursRaw = window.prompt(
      `How many hours of extension? Costs ${tokensPerHour} token${
        tokensPerHour === 1 ? '' : 's'
      } per hour. You have ${tokenBalance} token${tokenBalance === 1 ? '' : 's'}.`,
      '24'
    );
    if (!hoursRaw) return;
    const hours = Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0) return;
    const cost = Math.round(hours * tokensPerHour);
    if (cost > tokenBalance) {
      window.alert(
        `You need ${cost} tokens but only have ${tokenBalance}. Earn more tokens or reduce the hours.`
      );
      return;
    }
    fetcher.submit(
      { repository_assignment_id: repositoryAssignmentId, hours },
      {
        method: 'POST',
        action: `/student/${classSlug}/tasks/buy-extension`,
        encType: 'application/json',
      }
    );
    setTimeout(() => revalidate(), 400);
  };

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (typeFilter !== 'all' && t.kind !== typeFilter) return false;
      return true;
    });
  }, [tasks, statusFilter, typeFilter]);

  const grouped = useMemo(() => {
    const out: Record<Bucket, Task[]> = {
      overdue: [], today: [], week: [], later: [], undated: [],
    };
    const now = dayjs();
    for (const t of filtered) {
      out[bucketFor(t.dueAt, now)].push(t);
    }
    for (const b of BUCKET_ORDER) {
      out[b].sort((a, b2) => {
        if (!a.dueAt && !b2.dueAt) return 0;
        if (!a.dueAt) return 1;
        if (!b2.dueAt) return -1;
        return a.dueAt.getTime() - b2.dueAt.getTime();
      });
    }
    return out;
  }, [filtered]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Token balance pill */}
      <div className="md:col-span-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          Assignments
        </h1>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-800/50 text-[12.5px] text-amber-900 dark:text-amber-200">
          <span aria-hidden>🪙</span>
          <span className="font-mono font-medium">{tokenBalance}</span>
          <span>tokens</span>
        </div>
      </div>
      {/* Filter sidebar */}
      <aside className="panel md:sticky md:top-4 self-start p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="caps">Status</div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map(f => (
              <FilterChip
                key={f.key}
                active={statusFilter === f.key}
                onClick={() => setStatusFilter(f.key)}
                label={f.label}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="caps">Type</div>
          <div className="flex flex-wrap gap-1.5">
            {TYPE_FILTERS.map(f => (
              <FilterChip
                key={f.key}
                active={typeFilter === f.key}
                onClick={() => setTypeFilter(f.key)}
                label={f.label}
              />
            ))}
          </div>
        </div>
      </aside>

      {/* List */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="text-sm font-semibold tracking-tight">Assignments</h2>
          <span className="chip chip-ghost">{filtered.length}</span>
        </div>
        <div className="panel-body">
          {filtered.length === 0 ? (
            <div
              className="text-center py-12 text-sm"
              style={{ color: 'var(--ink-3)' }}
            >
              No assignments match these filters
            </div>
          ) : (
            <div className="flex flex-col">
              {BUCKET_ORDER.map(bucket => {
                const items = grouped[bucket];
                if (items.length === 0) return null;
                return (
                  <div key={bucket} className="flex flex-col">
                    <div className="caps pt-2 pb-1.5">{BUCKET_LABEL[bucket]}</div>
                    {items.map(t => (
                      <TaskRow
                        key={t.id}
                        task={t}
                        classSlug={classSlug}
                        tokenBalance={tokenBalance}
                        onBuyExtension={onBuyExtension}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip"
      style={
        active
          ? {
              background: 'var(--accent-soft)',
              color: 'var(--accent-ink)',
              borderColor: 'var(--accent-soft-2)',
              textTransform: 'none',
              fontWeight: 500,
              letterSpacing: 0,
              cursor: 'pointer',
            }
          : {
              background: 'var(--chip-neutral-bg)',
              color: 'var(--chip-neutral-ink)',
              borderColor: 'var(--chip-neutral-border)',
              textTransform: 'none',
              fontWeight: 500,
              letterSpacing: 0,
              cursor: 'pointer',
            }
      }
    >
      {label}
    </button>
  );
}

function TaskRow({
  task,
  classSlug,
  tokenBalance,
  onBuyExtension,
}: {
  task: Task;
  classSlug: string;
  tokenBalance: number;
  onBuyExtension: (repositoryAssignmentId: string, tokensPerHour: number) => void;
}) {
  const status = STATUS_CHIP[task.status];
  const subline = [task.moduleTitle, relativeDue(task.dueAt)].filter(Boolean).join(' · ');
  const hasGrade = (task.grades?.length ?? 0) > 0;
  const canBuyExtension =
    task.kind === 'asgn' &&
    !hasGrade &&
    task.isLate &&
    !task.isLateOverride &&
    (task.tokensPerHour ?? 0) > 0 &&
    tokenBalance > 0 &&
    Boolean(task.repositoryAssignmentId);
  const canResubmit = task.kind === 'asgn' && task.repositoryAssignmentId;

  return (
    <div
      className="grid items-center gap-3 px-2 py-2.5"
      style={{
        gridTemplateColumns: '80px 1fr auto auto',
        borderTop: '1px solid var(--line-cool)',
      }}
    >
      <Link
        to={task.href}
        className="flex items-center gap-2 row-hover"
        style={{ textDecoration: 'none' }}
      >
        <span className={`chip ${task.kind === 'quiz' ? 'chip-quiz' : 'chip-asgn'}`}>
          {task.kind === 'quiz' ? 'Quiz' : 'Asgn'}
        </span>
      </Link>
      <Link to={task.href} className="flex flex-col min-w-0" style={{ textDecoration: 'none' }}>
        <span
          className="truncate"
          style={{ fontSize: '13.5px', fontWeight: 500, color: 'var(--ink-1)' }}
        >
          {task.title}
        </span>
        <span className="text-xs truncate" style={{ color: 'var(--ink-3)' }}>
          {subline}
        </span>
        {hasGrade && (
          <span className="flex flex-wrap items-center gap-1.5 mt-1">
            {task.grades!.map((g, i) => (
              <span
                key={i}
                title={g.graderName ? `by ${g.graderName}` : undefined}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-800/50 text-[12px] text-amber-900 dark:text-amber-200"
              >
                <span>{g.emoji}</span>
                {g.grade !== null && (
                  <span className="font-mono text-[11px] text-amber-800 dark:text-amber-300">
                    {g.grade}
                  </span>
                )}
                {g.graderName && (
                  <span className="text-[10.5px] text-amber-800/80 dark:text-amber-300/80">
                    · {g.graderName}
                  </span>
                )}
              </span>
            ))}
            {task.isLateOverride && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-50 dark:bg-green-900/20 border border-green-200/70 dark:border-green-800/50 text-[11px] text-green-900 dark:text-green-200">
                🛡 Late waived
              </span>
            )}
          </span>
        )}
      </Link>
      <div className="flex items-center gap-1.5">
        {canResubmit && (
          <Link
            to={`/student/${classSlug}/regrade-requests/new`}
            state={{ assignment: { id: task.repositoryAssignmentId } }}
            className="px-2 py-1 rounded-md text-[11.5px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
          >
            Request resubmit
          </Link>
        )}
        {canBuyExtension && (
          <button
            type="button"
            onClick={() => onBuyExtension(task.repositoryAssignmentId!, task.tokensPerHour ?? 0)}
            className="px-2 py-1 rounded-md text-[11.5px] bg-amber-500 hover:bg-amber-600 text-white dark:bg-amber-600 dark:hover:bg-amber-500"
            title={`Spend ${task.tokensPerHour} tokens/hour to waive the late flag`}
          >
            Use tokens · waive late
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className={`chip ${status.className}`}>{status.label}</span>
        <IconChevronRight size={16} style={{ color: 'var(--ink-3)' }} />
      </div>
    </div>
  );
}

export default StudentTasks;
