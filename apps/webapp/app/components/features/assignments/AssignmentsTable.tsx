import { Popconfirm, Table, Tag } from 'antd';
import { Link } from 'react-router';
import dayjs from 'dayjs';
import {
  IconFileText,
  IconFolder,
  IconForms,
  IconHelpCircle,
  type Icon,
} from '@tabler/icons-react';

/** An assignment as the flat list and the module tab render it. */
export interface AssignmentRowData {
  id: string;
  title: string;
  type: string;
  /** REPO assignments: ISSUE (close an issue) or REPO (a push submits). */
  submission_mode?: 'ISSUE' | 'REPO' | string;
  weight: number;
  is_extra_credit: boolean;
  is_published: boolean;
  grades_released: boolean;
  release_at: string | Date | null;
  student_deadline: string | Date | null;
  grader_deadline: string | Date | null;
  tokens_per_hour: number;
  description?: string;
  module: { id: string; title: string; slug: string | null; position?: number };
  repository?: { id: string; title: string } | null;
  quiz?: { id: string; name: string } | null;
  form?: { id: string; title: string; slug?: string | null } | null;
  /** Pages / slide decks attached to the assignment (PageLink / SlideLink rows). */
  pages?: Array<{ page: { id: string } }>;
  slides?: Array<{ slide: { id: string } }>;
  _count?: { git_repo_assignments: number };
}

/** "Repo · push" / "Repo · issue" for REPO assignments, the plain type otherwise. */
export const assignmentTypeLabel = (a: AssignmentRowData): string => {
  const base = ASSIGNMENT_TYPE_META[a.type]?.label ?? a.type;
  if (a.type !== 'REPO') return base;
  return `${base} · ${a.submission_mode === 'REPO' ? 'push' : 'issue'}`;
};

export const ASSIGNMENT_TYPE_META: Record<string, { label: string; icon: Icon; color: string }> = {
  REPO: { label: 'Repo', icon: IconFolder, color: 'geekblue' },
  QUIZ: { label: 'Quiz', icon: IconHelpCircle, color: 'purple' },
  FORM: { label: 'Form', icon: IconForms, color: 'cyan' },
};

/** The thing an assignment points at, by type. */
export const assignmentTarget = (a: AssignmentRowData): string | null => {
  switch (a.type) {
    case 'REPO':
      return a.repository?.title ?? null;
    case 'QUIZ':
      return a.quiz?.name ?? null;
    case 'FORM':
      return a.form?.title ?? null;
    default:
      return null;
  }
};

const fmt = (value: string | Date | null, withTime = false) =>
  value ? dayjs(value).format(withTime ? 'MMM D, h:mm A' : 'MMM D') : '—';

interface AssignmentsTableProps {
  assignments: AssignmentRowData[];
  classSlug: string;
  /** Show which module each row belongs to (the flat page); off inside a module. */
  showModuleColumn?: boolean;
  onEdit: (assignment: AssignmentRowData) => void;
  onDelete: (assignment: AssignmentRowData) => void;
  busy?: boolean;
  emptyText?: string;
}

const AssignmentsTable = ({
  assignments,
  classSlug,
  showModuleColumn = true,
  onEdit,
  onDelete,
  busy = false,
  emptyText = 'No assignments yet',
}: AssignmentsTableProps) => {
  const columns = [
    {
      title: 'Assignment',
      key: 'title',
      ellipsis: true,
      render: (_: unknown, a: AssignmentRowData) => (
        <div className="flex items-center gap-2 min-w-0">
          <IconFileText size={16} className="text-gray-400 shrink-0" />
          <span className="text-ink-1 truncate">{a.title}</span>
          {a.is_extra_credit && (
            <Tag color="green" bordered={false} className="text-xs m-0 shrink-0">
              EC
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Type',
      key: 'type',
      width: 120,
      render: (_: unknown, a: AssignmentRowData) => {
        const meta = ASSIGNMENT_TYPE_META[a.type];
        return <Tag color={meta?.color}>{assignmentTypeLabel(a)}</Tag>;
      },
    },
    {
      title: 'Target',
      key: 'target',
      ellipsis: true,
      render: (_: unknown, a: AssignmentRowData) => (
        <span className="text-ink-2">{assignmentTarget(a) ?? '—'}</span>
      ),
    },
    {
      title: 'Module',
      key: 'module',
      ellipsis: true,
      render: (_: unknown, a: AssignmentRowData) => (
        <Link
          to={`/admin/${classSlug}/modules/${a.module.slug ?? a.module.id}`}
          className="text-ink-2 hover:text-ink-1"
        >
          {a.module.title}
        </Link>
      ),
    },
    {
      title: 'Weight',
      key: 'weight',
      width: 90,
      sorter: (x: AssignmentRowData, y: AssignmentRowData) => x.weight - y.weight,
      render: (_: unknown, a: AssignmentRowData) => (
        <span className="text-ink-2 tabular-nums">{a.weight}%</span>
      ),
    },
    {
      title: 'Release',
      key: 'release',
      width: 110,
      render: (_: unknown, a: AssignmentRowData) => (
        <span className="text-ink-2">{fmt(a.release_at)}</span>
      ),
    },
    {
      title: 'Due',
      key: 'due',
      width: 140,
      sorter: (x: AssignmentRowData, y: AssignmentRowData) =>
        dayjs(x.student_deadline ?? 0).valueOf() - dayjs(y.student_deadline ?? 0).valueOf(),
      render: (_: unknown, a: AssignmentRowData) => (
        <span className="text-ink-2">{fmt(a.student_deadline, true)}</span>
      ),
    },
    {
      title: 'Grader due',
      key: 'graderDue',
      width: 110,
      render: (_: unknown, a: AssignmentRowData) => (
        <span className="text-ink-2">{fmt(a.grader_deadline)}</span>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_: unknown, a: AssignmentRowData) => (
        <Tag color={a.is_published ? 'green' : 'orange'} className="font-semibold">
          {a.is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Grades',
      key: 'grades',
      width: 100,
      render: (_: unknown, a: AssignmentRowData) =>
        a.type === 'REPO' ? (
          <Tag color={a.grades_released ? 'green' : 'default'}>
            {a.grades_released ? 'Released' : 'Hidden'}
          </Tag>
        ) : (
          <span className="text-xs text-ink-3">Not graded</span>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_: unknown, a: AssignmentRowData) => (
        <div className="flex items-center gap-4 whitespace-nowrap">
          <button
            type="button"
            className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
            onClick={() => onEdit(a)}
            disabled={busy}
          >
            Edit
          </button>
          <Popconfirm
            title="Delete assignment"
            description={
              a.type === 'REPO'
                ? 'This deletes the assignment and every student submission and grade under it.'
                : 'This removes the assignment from its module. The quiz or form itself is kept.'
            }
            okText="Delete"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            onConfirm={() => onDelete(a)}
          >
            <button
              type="button"
              className="text-sm font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400"
              disabled={busy}
            >
              Delete
            </button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <Table
      columns={columns.filter(c => c.key !== 'module' || showModuleColumn)}
      dataSource={assignments}
      rowKey="id"
      rowHoverable={false}
      size="middle"
      scroll={{ x: 'max-content' }}
      pagination={false}
      locale={{
        emptyText: (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">{emptyText}</div>
            <div className="text-sm">
              An assignment is a repo issue, a quiz, or a form, with a weight and a due date.
            </div>
          </div>
        ),
      }}
    />
  );
};

export default AssignmentsTable;
