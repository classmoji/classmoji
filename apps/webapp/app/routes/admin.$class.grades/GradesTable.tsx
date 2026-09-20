import { useMemo, useState } from 'react';
import { ConfigProvider, Input, Popover, Select, Table, Tooltip } from 'antd';
import type { TableProps } from 'antd';
import { IconAdjustmentsHorizontal, IconSearch } from '@tabler/icons-react';
import { Link, useLocation, useParams } from 'react-router';
import dayjs from 'dayjs';
import { mean, median } from 'simple-statistics';

import { UserThumbnailView } from '~/components';
import GradeSettings from './GradeSettings';
import {
  calculateAssignmentGrade,
  calculateLetterGrade,
  calculateStudentFinalGrade,
} from '@classmoji/utils';
import type {
  GitRepo,
  GitRepoAssignment,
  LetterGradeMappingEntry,
  OrganizationSettings,
} from '@classmoji/utils';
import { useDarkMode } from '~/hooks';

/**
 * A gradebook row as it leaves the loader. A CLOSED shape on purpose: the
 * loader projects the User row down to this, and the contact fields are
 * present for an OWNER only.
 */
interface Student {
  id: string;
  name: string | null;
  login: string | null;
  /** UserThumbnailView reads `avatar_url`; the User model calls it `image`. */
  avatar_url: string | null;
  git_repos: GitRepo[];
  email?: string | null;
  provider_email?: string | null;
  school_id?: string | null;
}

interface Membership {
  id: string | number;
  user_id: string | number;
  comment?: string | null;
  letter_grade?: string | null;
}

/** A published assignment: one column. Standalone, never grouped. */
export interface GradebookAssignment {
  id: string;
  title: string;
  weight: number;
  is_extra_credit: boolean;
  type: string;
  module_id: string;
  module_title?: string;
  repository_id?: string | null;
  student_deadline?: string | Date | null;
  submission_mode?: string;
  grades_released?: boolean;
}

/** Kept for the loader's payload; the grid no longer groups by module. */
export interface GradebookModule {
  id: string;
  title: string;
  position: number;
}

/** A submission row with the fields the Prisma extension computes at read time. */
type Submission = GitRepoAssignment & {
  assignment_id?: string | number;
  status?: string;
  closed_at?: string | Date | null;
  is_late?: boolean;
  num_late_hours?: number;
  should_be_zero?: boolean;
};

type EmojiMappings = Record<string, number>;
type RowFilter = 'all' | 'ungraded' | 'missing' | 'late';

interface GradesTableProps {
  emojiMappings: EmojiMappings;
  modules: GradebookModule[];
  assignments: GradebookAssignment[];
  students: Student[];
  settings: OrganizationSettings;
  letterGradeMappings: LetterGradeMappingEntry[];
  memberships: Membership[];
}

/** The student's submission row for an assignment, wherever its git repo sits. */
const findSubmission = (student: Student, assignmentId: string): Submission | undefined => {
  for (const repo of student.git_repos) {
    const found = (repo.assignments as Submission[] | undefined)?.find(
      ra =>
        String(ra.assignment_id ?? (ra.assignment as { id?: string } | undefined)?.id) ===
        assignmentId
    );
    if (found) return found;
  }
  return undefined;
};

const isGraded = (s: Submission | undefined) => Boolean(s && (s.grades?.length ?? 0) > 0);
const isLate = (s: Submission | undefined) => Boolean(s?.is_late && !s.is_late_override);
const isSubmitted = (s: Submission | undefined) => s?.status === 'CLOSED';

const Chip = ({
  tone,
  children,
}: {
  tone: 'blue' | 'red' | 'amber' | 'grey';
  children: React.ReactNode;
}) => {
  const cls = {
    blue: 'text-sky-700 dark:text-sky-300',
    red: 'text-red-700 dark:text-red-300',
    amber: 'text-amber-700 dark:text-amber-300',
    grey: 'text-ink-3',
  }[tone];
  return <span className={`text-xs font-semibold whitespace-nowrap ${cls}`}>{children}</span>;
};

/**
 * The gradebook: students as rows, one column per published assignment in
 * deadline order, Total pinned beside the student. Read-only by design. Every
 * cell says where the submission stands and links to that student's row on the
 * assignment page, where grading happens.
 */
const GradesTable = (props: GradesTableProps) => {
  const {
    emojiMappings,
    assignments,
    students,
    settings,
    letterGradeMappings: initialLetterGradeMappings,
    memberships,
  } = props;
  const [letterGradeMappings, setLetterGradeMappings] = useState(initialLetterGradeMappings);
  const [rowFilter, setRowFilter] = useState<RowFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { class: classSlug } = useParams();
  const rolePrefix = useLocation().pathname.split('/')[1];
  const base = `/${rolePrefix}/${classSlug}`;
  const { isDarkMode } = useDarkMode();

  // Repo assignments carry grades; quiz and form assignments do not yet, so
  // they would be columns of dashes. In deadline order, undated last.
  const columnsSpec = useMemo(
    () =>
      assignments
        .filter(a => a.type === 'REPO')
        .sort((x, y) => {
          const dx = x.student_deadline ? new Date(x.student_deadline).getTime() : Infinity;
          const dy = y.student_deadline ? new Date(y.student_deadline).getTime() : Infinity;
          return dx - dy || x.title.localeCompare(y.title);
        }),
    [assignments]
  );

  const finalOf = (s: Student) => calculateStudentFinalGrade(s.git_repos, emojiMappings, settings);
  const rawOf = (s: Student) =>
    calculateStudentFinalGrade(s.git_repos, emojiMappings, settings, false);
  const individualOf = (s: Student) =>
    calculateStudentFinalGrade(s.git_repos, emojiMappings, settings, true, false);
  const membershipOf = (s: Student) => memberships.find(m => String(m.user_id) === String(s.id));
  const gradeOf = (s: Student, assignmentId: string) => {
    const sub = findSubmission(s, assignmentId);
    return sub ? calculateAssignmentGrade(sub, emojiMappings, settings) : null;
  };

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return students.filter(student => {
      if (q) {
        const hay = [student.name, student.login, student.email, student.provider_email]
          .map(v => (v ?? '').toLowerCase())
          .join(' ');
        if (!hay.includes(q)) return false;
      }
      if (rowFilter === 'all') return true;
      const subs = columnsSpec.map(a => findSubmission(student, a.id));
      if (rowFilter === 'ungraded') return subs.some(s => isSubmitted(s) && !isGraded(s));
      if (rowFilter === 'missing') return subs.some(s => s?.should_be_zero);
      if (rowFilter === 'late') return subs.some(s => isLate(s));
      return true;
    });
  }, [students, searchQuery, rowFilter, columnsSpec]);

  const toGradeCount = (assignmentId: string) =>
    students.reduce((n, s) => {
      const sub = findSubmission(s, assignmentId);
      return n + (isSubmitted(sub) && !isGraded(sub) ? 1 : 0);
    }, 0);

  const changeLetterGradeMapping = (letterGrade: string, grade: number) =>
    setLetterGradeMappings(
      letterGradeMappings.map(m =>
        m.letter_grade === letterGrade ? { ...m, min_grade: grade } : m
      )
    );

  const renderCell = (student: Student, assignment: GradebookAssignment) => {
    const sub = findSubmission(student, assignment.id);
    const href = `${base}/assignments/${assignment.id}${
      student.login ? `?q=${encodeURIComponent(student.login)}` : ''
    }`;
    let body: React.ReactNode;
    let tint = '';

    if (!sub) {
      body = <span className="text-ink-4">–</span>;
    } else if (isGraded(sub)) {
      const numeric = calculateAssignmentGrade(sub, emojiMappings, settings);
      body = (
        <span className="font-semibold tabular-nums">
          {numeric === null ? '–' : Math.round(numeric * 10) / 10}
        </span>
      );
      if (isLate(sub)) tint = 'bg-amber-50 dark:bg-amber-950/30';
      if (sub.is_late_override)
        body = (
          <span className="inline-flex items-center gap-1.5">
            {body}
            <Chip tone="grey">waived</Chip>
          </span>
        );
    } else if (isSubmitted(sub)) {
      body = (
        <Chip tone={isLate(sub) ? 'amber' : 'blue'}>
          {isLate(sub) ? 'Late · to grade' : 'To grade'}
        </Chip>
      );
      tint = isLate(sub) ? 'bg-amber-50 dark:bg-amber-950/30' : 'bg-sky-50 dark:bg-sky-950/30';
    } else if (sub.should_be_zero) {
      body = <Chip tone="red">Missing</Chip>;
      tint = 'bg-red-50 dark:bg-red-950/30';
    } else {
      body = <Chip tone="grey">Not submitted</Chip>;
    }

    return (
      <Link
        to={href}
        className={`flex items-center min-h-9 -m-2 p-2 rounded-md text-ink-1 hover:ring-1 hover:ring-line ${tint}`}
      >
        {body}
      </Link>
    );
  };

  const columns: TableProps<Student>['columns'] = [
    {
      title: (
        <div className="flex flex-col gap-0.5">
          <span>Student</span>
          <span className="text-[11px] font-medium text-ink-3">{students.length} enrolled</span>
        </div>
      ),
      key: 'student',
      fixed: 'left',
      width: 220,
      sorter: (a, b) => (a.name ?? a.login ?? '').localeCompare(b.name ?? b.login ?? ''),
      render: (_: unknown, student) => (
        <Link
          to={student.login ? `${base}/students/${student.login}` : '#'}
          className="block hover:underline underline-offset-2"
        >
          <UserThumbnailView user={student} truncate />
        </Link>
      ),
    },
    {
      title: (
        <div className="flex flex-col gap-0.5">
          <span>Total</span>
          <span className="text-[11px] font-medium text-ink-3">weighted · letter</span>
        </div>
      ),
      key: 'total',
      fixed: 'left',
      width: 150,
      className: 'border-r border-line',
      sorter: (a, b) => finalOf(a) - finalOf(b),
      defaultSortOrder: 'descend',
      render: (_: unknown, student) => {
        const final = finalOf(student);
        if (!(final >= 0)) return <span className="text-ink-4">–</span>;
        const raw = rawOf(student);
        const individual = individualOf(student);
        const override = membershipOf(student)?.letter_grade ?? null;
        const computed =
          letterGradeMappings.length > 0 ? calculateLetterGrade(final, letterGradeMappings) : null;
        const letter = override ?? computed;
        const tip = (
          <div className="text-xs flex flex-col gap-0.5">
            <span>Before late penalties: {Math.round(raw * 10) / 10}</span>
            <span>
              Individual work only: {individual >= 0 ? Math.round(individual * 10) / 10 : '–'}
            </span>
            {override && (
              <span>Letter overridden on the student report (computed {computed ?? '–'})</span>
            )}
          </div>
        );
        return (
          <Tooltip title={tip}>
            <span className="inline-flex items-center gap-2">
              <span className="font-bold tabular-nums">{Math.round(final * 10) / 10}</span>
              {letter && (
                <span
                  className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${
                    override
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300'
                  }`}
                >
                  {letter}
                </span>
              )}
            </span>
          </Tooltip>
        );
      },
    },
    ...columnsSpec.map(assignment => {
      const due = assignment.student_deadline
        ? dayjs(assignment.student_deadline).format('MMM D')
        : null;
      const pending = toGradeCount(assignment.id);
      return {
        title: (
          <div className="flex flex-col gap-0.5 min-w-0">
            <Link
              to={`${base}/assignments/${assignment.id}`}
              className="truncate text-ink-1 hover:underline underline-offset-2"
              title={assignment.title}
            >
              {assignment.title}
            </Link>
            <span className="text-[11px] font-medium text-ink-4 truncate">
              {assignment.module_title}
            </span>
            <span className="text-[11px] font-medium text-ink-3">
              {assignment.weight}%{assignment.is_extra_credit ? ' EC' : ''}
              {due ? ` · due ${due}` : ''}
            </span>
            {pending > 0 && (
              <span className="pt-0.5">
                <Chip tone="blue">{pending} to grade</Chip>
              </span>
            )}
          </div>
        ),
        key: `a-${assignment.id}`,
        width: 170,
        sorter: (a: Student, b: Student) =>
          (gradeOf(a, assignment.id) ?? -1) - (gradeOf(b, assignment.id) ?? -1),
        render: (_: unknown, student: Student) => renderCell(student, assignment),
      };
    }),
  ];

  const summary = (pageData: readonly Student[]) => {
    const finals = pageData.map(finalOf).filter(g => g >= 0);
    if (finals.length === 0) return null;
    return (
      <Table.Summary fixed>
        <Table.Summary.Row>
          <Table.Summary.Cell index={0}>
            <span className="text-xs font-semibold text-ink-3">Class</span>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={1}>
            <span className="text-xs text-ink-2 whitespace-nowrap">
              mean {mean(finals).toFixed(1)} · median {median(finals).toFixed(1)}
            </span>
          </Table.Summary.Cell>
          {columnsSpec.map((a, i) => {
            const grades = pageData
              .map(s => gradeOf(s, a.id))
              .filter((g): g is number => g !== null);
            return (
              <Table.Summary.Cell key={a.id} index={i + 2}>
                <span className="text-xs text-ink-2 tabular-nums">
                  {grades.length ? mean(grades).toFixed(1) : '–'}
                </span>
              </Table.Summary.Cell>
            );
          })}
        </Table.Summary.Row>
      </Table.Summary>
    );
  };

  return (
    <div className="min-h-full min-w-0">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Grades</h1>
          {(searchQuery || rowFilter !== 'all') && (
            <span className="text-xs text-ink-3 bg-nav-hover px-2.5 py-1 rounded-full">
              {rows.length} of {students.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <Input
            placeholder="Search students"
            prefix={<IconSearch size={16} />}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-56"
            data-tour="grades-search"
          />
          <Select<RowFilter>
            value={rowFilter}
            onChange={setRowFilter}
            className="min-w-52"
            data-tour="grades-filter"
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'ungraded', label: 'Has something to grade' },
              { value: 'missing', label: 'Has a missing submission' },
              { value: 'late', label: 'Late somewhere' },
            ]}
          />
          <div className="h-6 w-px bg-line" />
          <div className="flex items-center gap-1.5">
            <Popover
              trigger="click"
              placement="bottomRight"
              content={
                <GradeSettings
                  letterGradeMappings={letterGradeMappings}
                  changeLetterGradeMapping={changeLetterGradeMapping}
                />
              }
            >
              <button
                type="button"
                aria-label="Letter grade breakpoints"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 ring-1 ring-line hover:bg-nav-hover transition-colors"
              >
                <IconAdjustmentsHorizontal size={16} />
                Breakpoints
              </button>
            </Popover>
          </div>
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden bg-panel ring-1 ring-line min-h-[calc(100vh-10rem)] p-5 sm:p-6">
        <ConfigProvider
          theme={{
            components: {
              Table: {
                headerBg: isDarkMode ? '#1c2030' : '#fafafa',
                headerColor: isDarkMode ? '#d9dbe3' : '#374151',
              },
            },
          }}
        >
          <Table<Student>
            dataSource={rows}
            columns={columns}
            rowKey="id"
            rowHoverable
            size="small"
            bordered
            sticky
            scroll={{ x: 370 + columnsSpec.length * 170 }}
            pagination={{
              pageSize: 50,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} students`,
            }}
            summary={summary}
            locale={{
              emptyText: (
                <div className="text-center py-12 text-gray-500">
                  <div className="font-medium">
                    {students.length === 0 ? 'No students yet' : 'Nobody matches this filter'}
                  </div>
                  <div className="text-sm">
                    {students.length === 0
                      ? 'Students appear here once they join the classroom.'
                      : 'Pick another filter or clear the search.'}
                  </div>
                </div>
              ),
            }}
            className="rounded-lg"
          />
        </ConfigProvider>
        <div className="flex items-center gap-4 pt-3 text-xs text-ink-3 flex-wrap">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-sky-50 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:ring-sky-800" />
            Submitted, to grade
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-amber-50 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-800" />
            Late
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-red-50 ring-1 ring-red-200 dark:bg-red-950/40 dark:ring-red-800" />
            Missing
          </span>
          <span className="flex-1" />
          <span>
            Click a cell to grade it on the assignment page. Click a student for their report.
          </span>
        </div>
      </div>
    </div>
  );
};

export default GradesTable;
