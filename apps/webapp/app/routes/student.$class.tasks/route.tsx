import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import dayjs from 'dayjs';
import { IconChevronRight } from '@tabler/icons-react';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';

// --- Types -----------------------------------------------------------------

type TaskKind = 'asgn' | 'quiz';
type TaskStatus = 'open' | 'submitted' | 'late' | 'done' | 'upcoming' | 'locked';

interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  dueAt: Date | null;
  status: TaskStatus;
  moduleTitle?: string;
  href: string;
}

interface LoaderRepoAssignment {
  id: string;
  status: string;
  provider_issue_number?: number | null;
  assignment: {
    id: string;
    title: string;
    student_deadline: string | Date | null;
  };
  repository: {
    name: string;
    module: { id: string; title: string } | null;
  };
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

  const [rawRepoAssignments, rawQuizzes] = (await Promise.all([
    ClassmojiService.repositoryAssignment.findForUser({
      repository: { student_id: userId, classroom_id: classroom.id },
    }),
    ClassmojiService.quiz.getQuizzesForStudent(classroom.id, userId, membership),
  ])) as unknown as [LoaderRepoAssignment[], LoaderQuiz[]];

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

    tasks.push({
      id: `asgn-${ra.id}`,
      kind: 'asgn',
      title: ra.assignment.title,
      dueAt: due,
      status,
      moduleTitle: ra.repository.module?.title,
      href: `/student/${classSlug}/assignments/${ra.assignment.id}`,
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

  return { classSlug, tasks };
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
  const { tasks } = loaderData;
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | TaskKind>('all');

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
                      <TaskRow key={t.id} task={t} />
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

function TaskRow({ task }: { task: Task }) {
  const status = STATUS_CHIP[task.status];
  const subline = [task.moduleTitle, relativeDue(task.dueAt)]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link
      to={task.href}
      className="row-hover grid items-center gap-3 px-2 py-2.5"
      style={{
        gridTemplateColumns: 'auto 1fr auto auto',
        borderTop: '1px solid var(--line-cool)',
      }}
    >
      <span className={`chip ${task.kind === 'quiz' ? 'chip-quiz' : 'chip-asgn'}`}>
        {task.kind === 'quiz' ? 'Quiz' : 'Asgn'}
      </span>
      <div className="flex flex-col min-w-0">
        <span
          className="truncate"
          style={{ fontSize: '13.5px', fontWeight: 500, color: 'var(--ink-1)' }}
        >
          {task.title}
        </span>
        <span className="text-xs truncate" style={{ color: 'var(--ink-3)' }}>
          {subline}
        </span>
      </div>
      <span className={`chip ${status.className}`}>{status.label}</span>
      <IconChevronRight size={16} style={{ color: 'var(--ink-3)' }} />
    </Link>
  );
}

export default StudentTasks;
