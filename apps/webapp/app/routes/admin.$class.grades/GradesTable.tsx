import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ConfigProvider, Input, Popover, Segmented, Select, Table, Tooltip } from 'antd';
import type { TableProps } from 'antd';
import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconSearch,
} from '@tabler/icons-react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import dayjs from 'dayjs';
import { mean, median } from 'simple-statistics';

import { UserThumbnailView } from '~/components';
import GradeSettings from './GradeSettings';
import FinalGradesControl from './FinalGradesControl';
import {
  calculateAssignmentGrade,
  calculateStudentFinalGrade,
  finalStudentGrade,
  gradedItemValue,
  quizItemEmoji,
  quizPercentageEmoji,
} from '@classmoji/utils';
import type {
  GitRepo,
  GitRepoAssignment,
  GradedItem,
  LetterGradeMappingEntry,
  OrganizationSettings,
} from '@classmoji/utils';
import { useDarkMode } from '~/hooks';
import EmojiGrader from '~/components/features/grading/EmojiGrader';
import QuizGradeEmoji from '~/components/features/quiz/QuizGradeEmoji';
import Emoji from '~/components/ui/display/Emoji';
import {
  firstInColumn,
  freezeWalk,
  pendingByColumn,
  walkOrder,
  type SubmissionPanelOutletContext,
  type WalkCell,
  type WalkCellInput,
} from './gradingWalk';

/**
 * A gradebook row as it leaves the loader. A CLOSED shape on purpose: the
 * loader projects the User row down to this, and the contact fields are
 * present for an OWNER only.
 */
export interface Student {
  id: string;
  name: string | null;
  login: string | null;
  /** UserThumbnailView reads `avatar_url`; the User model calls it `image`. */
  avatar_url: string | null;
  git_repos: GitRepo[];
  /**
   * Quiz grade items: what each quiz assignment adds to the totals. An
   * assignment with no item (not open yet, before the deadline, or only an
   * unscored attempt) adds nothing.
   */
  quiz_items: GradedItem[];
  /**
   * The quiz assignments on which staff waived this student's late penalty
   * (#813): the cell's "waived" chip, with or without a grade item.
   */
  quiz_waived_ids?: string[];
  email?: string | null;
  school_id?: string | null;
  /** Teams view only: the row is a team, and these are its members on the roster. */
  members?: { id: string; name: string | null; login: string | null }[];
}

/** A team with members, by member id: one row of the Teams view. */
export interface GradebookTeam {
  id: string;
  name: string;
  member_ids: string[];
}

/** Open regrade requests by where they show: ids only. */
export interface GradebookOpenRegrades {
  /** Submission id → request id. */
  submissions: Record<string, string>;
  /** Quiz assignment id → student id → request id. */
  quizzes: Record<string, Record<string, string>>;
}

interface Membership {
  id: string | number;
  user_id: string | number;
  letter_grade?: string | null;
}

/** A published assignment: one column, under its module's group header. */
export interface GradebookAssignment {
  id: string;
  title: string;
  weight: number;
  is_extra_credit: boolean;
  type: string;
  module_id: string;
  module_title?: string;
  created_at?: string | Date;
  repository_id?: string | null;
  student_deadline?: string | Date | null;
  /** When a QUIZ or FORM opens to students; null = when published. */
  release_at?: string | Date | null;
  submission_mode?: string;
  grades_released?: boolean;
  quiz_id?: string | null;
  form_id?: string | null;
  /** The repository's type (INDIVIDUAL / GROUP); null for quiz and form columns. */
  repository_type?: string | null;
}

/** Per-student state for quiz and form assignments, keyed by assignment id then user id. */
export interface GradebookActivity {
  /**
   * `emoji`: the counting attempt's effective grade as the classroom's emoji,
   * or null when no completed attempt is scored. No quiz number reaches the
   * page outside the grade items (E1).
   */
  /** `scored`: the counting attempt has a score (absent on older payloads). */
  quiz: Record<
    string,
    Record<
      string,
      { completed: boolean; scored?: boolean; emoji: string | null; orphaned?: boolean }
    >
  >;
  form: Record<string, Record<string, { submitted: boolean }>>;
}

/** The classroom's modules, in course order: one column group each. */
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
export type RowFilter = 'all' | 'ungraded' | 'missing' | 'late';
export type GradebookView = 'students' | 'teams';
export type GradeDisplay = 'emoji' | 'numbers';

interface GradesTableProps {
  emojiMappings: EmojiMappings;
  modules: GradebookModule[];
  assignments: GradebookAssignment[];
  students: Student[];
  settings: OrganizationSettings;
  letterGradeMappings: LetterGradeMappingEntry[];
  memberships: Membership[];
  activity?: GradebookActivity;
  /** Whether students see their final grade (the Letter column). */
  finalGradesReleased?: boolean;
  /** Owner only: may release or hide final grades. */
  canReleaseFinalGrades?: boolean;
  openRegrades?: GradebookOpenRegrades;
  teams?: GradebookTeam[];
}

/** The student's submission row for an assignment, wherever its git repo sits. */
type StudentGitRepo = GitRepo & {
  id?: string;
  name?: string;
  student_id?: string | null;
  team_id?: string | null;
};

const findSubmissionWithRepo = (
  student: Student,
  assignmentId: string
): { sub: Submission; repo: StudentGitRepo } | undefined => {
  for (const repo of student.git_repos as StudentGitRepo[]) {
    const found = (repo.assignments as Submission[] | undefined)?.find(
      ra =>
        String(ra.assignment_id ?? (ra.assignment as { id?: string } | undefined)?.id) ===
        assignmentId
    );
    if (found) return { sub: found, repo };
  }
  return undefined;
};

const findSubmission = (student: Student, assignmentId: string): Submission | undefined =>
  findSubmissionWithRepo(student, assignmentId)?.sub;

const isGraded = (s: Submission | undefined) => Boolean(s && (s.grades?.length ?? 0) > 0);
const isLate = (s: Submission | undefined) => Boolean(s?.is_late && !s.is_late_override);
const isSubmitted = (s: Submission | undefined) => s?.status === 'CLOSED';
/** To grade: submitted with no grade yet, or an open regrade request on it. */
const needsGrading = (s: Submission, openRegradeSubmissions: Record<string, string>) =>
  (isSubmitted(s) && !isGraded(s)) || Boolean(openRegradeSubmissions[String(s.id)]);

const quizItemOf = (student: Student, assignmentId: string): GradedItem | undefined =>
  (student.quiz_items ?? []).find(item => item.assignment_id === assignmentId);
/** The value a quiz adds to the totals (late-penalised; 0 when counted zero), or null. */
const quizValueOf = (student: Student, assignmentId: string): number | null => {
  const item = quizItemOf(student, assignmentId);
  return item ? gradedItemValue(item) : null;
};
/** Whether a quiz has not opened to students yet (`release_at` still ahead). */
const opensLater = (assignment: GradebookAssignment, now = Date.now()) =>
  assignment.release_at != null && new Date(assignment.release_at).getTime() > now;
/**
 * Completed attempts with no score yet and nothing counted: the score is
 * still to come. Never a counted zero (that has an item).
 */
const quizPending = (activity: GradebookActivity, student: Student, assignmentId: string) => {
  if (quizItemOf(student, assignmentId)) return false;
  const q = activity.quiz[assignmentId]?.[student.id];
  return Boolean(q?.completed && q.emoji === null);
};
/**
 * Whether a student's row passes the gradebook filter, over the visible
 * columns. "Has something to grade" includes a quiz whose score is still to
 * come; missing and late include quiz items.
 */
export const matchesRowFilter = (
  student: Student,
  rowFilter: RowFilter,
  columnsSpec: readonly GradebookAssignment[],
  activity: GradebookActivity,
  openRegradeSubmissions: Record<string, string> = {}
): boolean => {
  if (rowFilter === 'all') return true;
  const subs = columnsSpec.filter(a => a.type === 'REPO').map(a => findSubmission(student, a.id));
  const quizColumns = columnsSpec.filter(a => a.type === 'QUIZ');
  const quizItems = quizColumns.flatMap(a => quizItemOf(student, a.id) ?? []);
  if (rowFilter === 'ungraded')
    return (
      subs.some(s => s && needsGrading(s, openRegradeSubmissions)) ||
      quizColumns.some(a => quizPending(activity, student, a.id))
    );
  if (rowFilter === 'missing')
    return subs.some(s => s?.should_be_zero) || quizItems.some(i => i.counts_as_zero);
  if (rowFilter === 'late')
    return subs.some(s => isLate(s)) || quizItems.some(i => i.late_hours > 0);
  return true;
};
/**
 * Whether the breakpoints in the popover differ from the saved ones. Edits
 * there are never saved, while students' final grades read the saved cutoffs,
 * so the Letter column then shows letters students would not get.
 */
export const breakpointsEdited = (
  saved: readonly LetterGradeMappingEntry[],
  local: readonly LetterGradeMappingEntry[]
): boolean => {
  const savedMin = new Map(saved.map(m => [m.letter_grade, m.min_grade]));
  return (
    saved.length !== local.length ||
    local.some(m => !savedMin.has(m.letter_grade) || savedMin.get(m.letter_grade) !== m.min_grade)
  );
};

/** Teams view rows: a team's members from the roster, and the repos they share. */
export const buildTeamRows = (teams: readonly GradebookTeam[], students: readonly Student[]) => {
  const byId = new Map(students.map(s => [s.id, s]));
  return teams.flatMap(team => {
    const members = team.member_ids.flatMap(id => byId.get(id) ?? []);
    if (members.length === 0) return [];
    const repos = new Map<string, GitRepo>();
    for (const member of members) {
      for (const repo of member.git_repos as StudentGitRepo[]) {
        if (repo.team_id === team.id) repos.set(String(repo.id ?? repo.name), repo);
      }
    }
    const row: Student = {
      id: team.id,
      name: team.name,
      login: null,
      avatar_url: null,
      git_repos: [...repos.values()],
      quiz_items: [],
      members: members.map(m => ({ id: m.id, name: m.name, login: m.login })),
    };
    return [row];
  });
};

/** A per-viewer setting kept in this browser; the default until it has been read. */
const useRemembered = <T extends string>(key: string, initial: T, allowed: readonly T[]) => {
  const [value, setValue] = useState<T>(initial);
  // Read after mount, so the server render and the first client render agree.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key) as T | null;
      if (stored && allowed.includes(stored)) setValue(stored);
    } catch {
      // Storage unavailable: keep the default.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  };
  return [value, set] as const;
};

const LATE_TINT = 'bg-amber-50 dark:bg-amber-950/30';
const MISSING_TINT = 'bg-red-50 dark:bg-red-950/30';

const Chip = ({
  tone,
  children,
}: {
  tone: 'blue' | 'red' | 'amber' | 'grey' | 'violet';
  children: React.ReactNode;
}) => {
  const cls = {
    violet: 'text-violet-700 dark:text-violet-300',
    blue: 'text-sky-700 dark:text-sky-300',
    red: 'text-red-700 dark:text-red-300',
    amber: 'text-amber-700 dark:text-amber-300',
    grey: 'text-ink-3',
  }[tone];
  return <span className={`text-xs font-semibold whitespace-nowrap ${cls}`}>{children}</span>;
};

/**
 * The gradebook: students as rows, one column per published assignment
 * grouped under its module, each module closing with its own total, and the
 * class Total pinned beside the student. Repo cells grade in place through the
 * hover picker, and open the submission panel (a child route) beside the
 * table, which walks the cells still to grade. The Teams view shows one row
 * per team over the group repository columns only.
 */
// Stable defaults, so a missing prop does not defeat the memoized grid.
const NO_MODULES: GradebookModule[] = [];
const NO_ACTIVITY: GradebookActivity = { quiz: {}, form: {} };
const NO_REGRADES: GradebookOpenRegrades = { submissions: {}, quizzes: {} };
const NO_TEAMS: GradebookTeam[] = [];
const PAGE_SIZE = 50;

/** A cell id usable inside a CSS attribute selector (uuids and numeric ids). */
const cssId = (id: string) => id.replace(/[^\w-]/g, '');

const GradesTable = (props: GradesTableProps) => {
  const {
    emojiMappings,
    modules = NO_MODULES,
    assignments,
    students,
    settings,
    letterGradeMappings: initialLetterGradeMappings,
    memberships,
    activity = NO_ACTIVITY,
    finalGradesReleased = false,
    canReleaseFinalGrades = false,
    openRegrades = NO_REGRADES,
    teams = NO_TEAMS,
  } = props;
  const [letterGradeMappings, setLetterGradeMappings] = useState(initialLetterGradeMappings);
  const [rowFilter, setRowFilter] = useState<RowFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const { class: classSlug, submissionId: openSubmissionId } = useParams();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const rolePrefix = pathname.split('/')[1];
  // Owners and teachers reach this page; both may grade.
  const canGrade = true;
  const base = `/${rolePrefix}/${classSlug}`;
  const { isDarkMode } = useDarkMode();
  // The panel's URL keeps the gradebook's own search params, so closing it
  // lands on the same gradebook.
  const panelHref = (submissionId: string) => `${base}/grades/submissions/${submissionId}${search}`;
  // Read by handlers inside the memoized grid, so opening or walking the
  // panel never rebuilds it.
  const openIdRef = useRef(openSubmissionId);
  openIdRef.current = openSubmissionId;

  /*
   * The walk the panel follows, frozen while the panel is open: grading a
   * cell re-sorts the table (by Total, or by its column) and can drop the row
   * from the filter, and a walk rebuilt from the table would then skip cells.
   * It is taken from the table as shown when the panel opens, and again when
   * the viewer changes the sort, filter, search, view or columns, or presses
   * Start. A ref, set during render: the snapshot is derived from the render
   * that opened the panel, and setting it again is a no-op.
   */
  const frozenWalkRef = useRef<WalkCell[] | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const unfreeze = () => {
    frozenWalkRef.current = null;
  };

  const [storedView, setStoredView] = useRemembered<GradebookView>(
    'classmoji.gradebook.view',
    'students',
    ['students', 'teams']
  );
  const [display, setDisplay] = useRemembered<GradeDisplay>(
    'classmoji.gradebook.display',
    'emoji',
    ['emoji', 'numbers']
  );
  const teamRows = useMemo(() => buildTeamRows(teams, students), [teams, students]);
  // A remembered Teams view falls back to Students in a classroom without teams.
  const view: GradebookView = storedView === 'teams' && teamRows.length > 0 ? 'teams' : 'students';
  const isTeams = view === 'teams';
  const setView = (next: GradebookView) => {
    unfreeze();
    setStoredView(next);
  };

  // Every published assignment is a column, grouped under its module in the
  // course's module order (the same shape as the student report); inside a
  // module, columns run in the order the assignments were created.
  const groups = useMemo(() => {
    const byCreated = (x: GradebookAssignment, y: GradebookAssignment) =>
      new Date(x.created_at ?? 0).getTime() - new Date(y.created_at ?? 0).getTime() ||
      x.title.localeCompare(y.title);
    const position = new Map(modules.map(m => [m.id, m.position]));
    const byModule = new Map<string, { id: string; title: string; items: GradebookAssignment[] }>();
    for (const a of assignments) {
      const g = byModule.get(a.module_id) ?? {
        id: a.module_id,
        title: a.module_title ?? modules.find(m => m.id === a.module_id)?.title ?? 'Module',
        items: [],
      };
      g.items.push(a);
      byModule.set(a.module_id, g);
    }
    return [...byModule.values()]
      .sort(
        (g, h) =>
          (position.get(g.id) ?? Infinity) - (position.get(h.id) ?? Infinity) ||
          g.title.localeCompare(h.title)
      )
      .map(g => ({
        ...g,
        // The Teams view shows team work only: group repository columns.
        items: [...g.items]
          .filter(a => !isTeams || (a.type === 'REPO' && a.repository_type === 'GROUP'))
          .sort(byCreated),
      }))
      .filter(g => g.items.length > 0);
  }, [assignments, modules, isTeams]);
  const columnsSpec = useMemo(() => groups.flatMap(g => g.items), [groups]);

  const itemsOf = (s: Student) => s.quiz_items ?? [];
  const finalOf = (s: Student) =>
    calculateStudentFinalGrade(s.git_repos, emojiMappings, settings, true, true, itemsOf(s));
  // A module's total is the same weighted math as the class total, run over
  // just that module's repo assignments and quiz items. Forms carry no grade.
  const moduleTotalOf = (s: Student, moduleId: string, assignmentIds: Set<string>) => {
    const repos = s.git_repos.map(repo => ({
      ...repo,
      assignments: (repo.assignments ?? []).filter(ra =>
        assignmentIds.has(String((ra as Submission).assignment_id))
      ),
    }));
    const items = itemsOf(s).filter(item => item.module_id === moduleId);
    return calculateStudentFinalGrade(repos, emojiMappings, settings, true, true, items);
  };
  // Collapsed modules show only their total column.
  const [collapsedModules, setCollapsedModules] = useState<Set<string>>(new Set());
  const toggleModule = (id: string) => {
    unfreeze();
    setCollapsedModules(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const rawOf = (s: Student) =>
    calculateStudentFinalGrade(s.git_repos, emojiMappings, settings, false, true, itemsOf(s));
  // Quizzes are individual work, so their items always count here.
  const individualOf = (s: Student) =>
    calculateStudentFinalGrade(s.git_repos, emojiMappings, settings, true, false, itemsOf(s));
  const membershipOf = (s: Student) => memberships.find(m => String(m.user_id) === String(s.id));
  const gradeOf = (s: Student, assignmentId: string) => {
    const sub = findSubmission(s, assignmentId);
    return sub ? calculateAssignmentGrade(sub, emojiMappings, settings) : null;
  };

  // Every row of the current view, before search and filter.
  const viewRows = isTeams ? teamRows : students;
  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return viewRows.filter(row => {
      if (q) {
        const hay = [
          row.name,
          row.login,
          row.email,
          ...(row.members ?? []).flatMap(m => [m.name, m.login]),
        ]
          .map(v => (v ?? '').toLowerCase())
          .join(' ');
        if (!hay.includes(q)) return false;
      }
      return matchesRowFilter(row, rowFilter, columnsSpec, activity, openRegrades.submissions);
    });
  }, [viewRows, searchQuery, rowFilter, columnsSpec, activity, openRegrades]);

  // The repo columns on screen (a collapsed module shows only its total).
  const walkColumnIds = useMemo(
    () =>
      groups
        .filter(g => isTeams || !collapsedModules.has(g.id))
        .flatMap(g => g.items)
        .filter(a => a.type === 'REPO')
        .map(a => a.id),
    [groups, collapsedModules, isTeams]
  );
  /** A row's submission in a repo column, and whether it is to grade. */
  const walkCellOf = (row: Student, assignmentId: string): WalkCellInput | null => {
    const sub = findSubmission(row, assignmentId);
    if (!sub) return null;
    return {
      submissionId: String(sub.id),
      needsGrading: needsGrading(sub, openRegrades.submissions),
    };
  };
  // Whether each submission of the view is to grade now, search and filter
  // aside: what a frozen walk reads its cells against.
  const needsGradingNow = useMemo(
    () =>
      new Map(
        walkOrder(
          viewRows,
          columnsSpec.filter(a => a.type === 'REPO').map(a => a.id),
          walkCellOf
        ).map(c => [c.submissionId, c.needsGrading])
      ),
    // walkCellOf reads only openRegrades beyond its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewRows, columnsSpec, openRegrades]
  );
  // The header's "N to grade" per column, over the rows the walk uses
  // (search and filter applied; each team submission once), so Start never
  // opens a cell outside the walk. Counting needs no order.
  const pendingCounts = useMemo(
    () => pendingByColumn(walkOrder(rows, walkColumnIds, walkCellOf)),
    // walkCellOf reads only openRegrades beyond its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, walkColumnIds, openRegrades]
  );
  // The live walk, for handlers inside the memoized grid (Start).
  const liveWalkRef = useRef<WalkCell[]>([]);

  // The table's sort, held here so the walk follows the rows as shown.
  const [sort, setSort] = useState<{ key: string; order: 'ascend' | 'descend' | null }>({
    key: 'total',
    order: 'descend',
  });
  const sortOrderOf = (key: string) => (sort.key === key ? sort.order : null);

  const changeLetterGradeMapping = (letterGrade: string, grade: number) =>
    setLetterGradeMappings(
      letterGradeMappings.map(m =>
        m.letter_grade === letterGrade ? { ...m, min_grade: grade } : m
      )
    );

  /**
   * A quiz cell. With a grade item it shows what the totals count as the
   * classroom's emoji (E1): the late-penalised score (amber when late, with
   * its late chip), an "adjusted" chip when staff adjusted the counting
   * attempt (D8; on time it shows the emoji staff picked, `quizItemEmoji`), a
   * "needs remap" chip when that adjustment's emoji left the scale (E17), or
   * Missing (a counted 0). Without one it shows when the quiz opens, or the
   * attempt state (before the deadline, running or unscored). A "waived" chip
   * follows a finished attempt's grade (or its pending score) where staff
   * waived the student's late penalty, as on a waived repo cell. Never on
   * Missing or Not attempted: a waiver takes away late penalties, not the
   * zero for not taking the quiz.
   */
  const renderQuizCell = (
    student: Student,
    assignment: GradebookAssignment
  ): { body: React.ReactNode; tint: string } => {
    const item = quizItemOf(student, assignment.id);
    const finished = activity.quiz[assignment.id]?.[student.id]?.completed === true;
    const waived =
      item?.late_waived === true ||
      (!item?.counts_as_zero &&
        finished &&
        (student.quiz_waived_ids ?? []).includes(assignment.id));
    const cell = renderQuizCellBody(student, assignment);
    return waived
      ? {
          body: (
            <span className="inline-flex items-center gap-1.5">
              {cell.body}
              <Chip tone="grey">waived</Chip>
            </span>
          ),
          tint: cell.tint,
        }
      : cell;
  };

  const renderQuizCellBody = (
    student: Student,
    assignment: GradebookAssignment
  ): { body: React.ReactNode; tint: string } => {
    const item = quizItemOf(student, assignment.id);
    if (item?.counts_as_zero) {
      // Counts 0 in the totals; a running attempt past the deadline is one too.
      return { body: <Chip tone="red">Missing</Chip>, tint: MISSING_TINT };
    }
    const value = item ? gradedItemValue(item) : null;
    if (item && value !== null) {
      const late = item.late_hours > 0;
      return {
        body: (
          <QuizGradeEmoji
            emoji={quizItemEmoji(item, value, emojiMappings)}
            adjusted={item.counting_adjusted === true}
            orphaned={item.counting_orphaned === true}
            lateHours={item.late_hours}
          />
        ),
        tint: late ? LATE_TINT : '',
      };
    }
    if (!item && opensLater(assignment)) {
      return {
        body: <Chip tone="grey">Opens {dayjs(assignment.release_at).format('MMM D')}</Chip>,
        tint: '',
      };
    }
    const q = activity.quiz[assignment.id]?.[student.id];
    const body = !q ? (
      <Chip tone="grey">Not attempted</Chip>
    ) : !q.completed ? (
      <Chip tone="blue">In progress</Chip>
    ) : q.emoji === null ? (
      <span className="font-semibold">Completed</span>
    ) : (
      <QuizGradeEmoji emoji={q.emoji} orphaned={q.orphaned === true} />
    );
    return { body, tint: '' };
  };

  const renderCell = (student: Student, assignment: GradebookAssignment) => {
    if (assignment.type === 'QUIZ') {
      const href = assignment.quiz_id ? `${base}/quizzes/${assignment.quiz_id}` : null;
      const { body, tint } = renderQuizCell(student, assignment);
      const cls = `flex items-center gap-2 min-h-9 -m-2 p-2 rounded-md ${tint}`;
      // An open quiz request resolves in its own modal on the requests page.
      const requestId = openRegrades.quizzes[assignment.id]?.[student.id];
      const regrade = requestId ? (
        <Link
          to={`${base}/regrade-requests?resolve=${encodeURIComponent(requestId)}`}
          className="hover:underline underline-offset-2"
          data-testid="gradebook-quiz-regrade"
        >
          <Chip tone="violet">Regrade</Chip>
        </Link>
      ) : null;
      const cell = href ? (
        <Link to={href} className={`${cls} text-ink-1 hover:ring-1 hover:ring-line`}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      );
      // Two sibling links, never one inside the other.
      return regrade ? (
        <div className="flex items-center justify-between gap-2">
          {cell}
          {regrade}
        </div>
      ) : (
        cell
      );
    }
    if (assignment.type === 'FORM') {
      const f = activity.form[assignment.id]?.[student.id];
      return f?.submitted ? (
        <Chip tone="grey">Responded</Chip>
      ) : (
        <Chip tone="grey">No response</Chip>
      );
    }
    const hit = findSubmissionWithRepo(student, assignment.id);
    const sub = hit?.sub;
    const regradeOpen = Boolean(sub && openRegrades.submissions[String(sub.id)]);
    let body: React.ReactNode;
    let tint = '';

    if (!sub) {
      body = <span className="text-ink-4">–</span>;
    } else if (isGraded(sub)) {
      const numeric = calculateAssignmentGrade(sub, emojiMappings, settings);
      const grade =
        display === 'emoji' ? (
          <span className="inline-flex items-center gap-0.5" data-testid="gradebook-cell-emoji">
            {(sub.grades ?? []).map((g, i) => (
              <Emoji key={(g as { id?: string }).id ?? i} emoji={g.emoji} fontSize={16} />
            ))}
          </span>
        ) : (
          <span className="font-semibold tabular-nums">
            {numeric === null ? '–' : Math.round(numeric * 10) / 10}
          </span>
        );
      body = regradeOpen ? (
        <span className="inline-flex items-center gap-1.5">
          <Chip tone="violet">Regrade ·</Chip>
          {grade}
        </span>
      ) : (
        grade
      );
      if (isLate(sub)) tint = LATE_TINT;
      if (sub.is_late_override)
        body = (
          <span className="inline-flex items-center gap-1.5">
            {body}
            <Chip tone="grey">waived</Chip>
          </span>
        );
    } else if (regradeOpen) {
      body = <Chip tone="violet">Regrade</Chip>;
    } else if (isSubmitted(sub)) {
      body = (
        <Chip tone={isLate(sub) ? 'amber' : 'blue'}>
          {isLate(sub) ? 'Late · to grade' : 'To grade'}
        </Chip>
      );
      if (isLate(sub)) tint = LATE_TINT;
    } else if (sub.should_be_zero) {
      body = <Chip tone="red">Missing</Chip>;
      tint = MISSING_TINT;
    } else {
      body = <Chip tone="grey">Not submitted</Chip>;
    }

    // Grade right here with the same picker and API as the assignment page.
    const control =
      hit && canGrade ? (
        <EmojiGrader
          repositoryAssignment={{
            id: sub!.id,
            assignment_id: assignment.id,
            studentId: hit.repo.student_id ?? undefined,
            teamId: hit.repo.team_id ?? undefined,
            grades: (sub!.grades ?? []) as Parameters<
              typeof EmojiGrader
            >[0]['repositoryAssignment']['grades'],
            repository: { name: hit.repo.name ?? null },
          }}
          emojiMappings={emojiMappings as Record<string, unknown>}
        />
      ) : null;

    // The open cell is marked by a style rule keyed on this attribute (see
    // the <style> below), so walking the panel re-renders no cell.
    return (
      <div
        className={`flex items-center justify-between gap-2 min-h-9 -m-2 p-2 rounded-md ${tint}`}
        data-gradebook-cell={sub ? cssId(String(sub.id)) : undefined}
      >
        {sub ? (
          // Opens the submission panel beside the gradebook.
          <Link
            to={panelHref(String(sub.id))}
            preventScrollReset
            // The open cell is already showing: no navigation, no reload.
            onClick={e => {
              if (openIdRef.current === String(sub.id)) e.preventDefault();
            }}
            className="text-ink-1 hover:underline underline-offset-2"
            data-testid="gradebook-cell-open"
          >
            {body}
          </Link>
        ) : (
          body
        )}
        {control}
      </div>
    );
  };

  // The columns, rebuilt only when what the cells show changes: never on a
  // panel step, which would re-render every cell (totals, pickers).
  const columns = useMemo(() => {
    const assignmentColumn = (assignment: GradebookAssignment) => {
      const due = assignment.student_deadline
        ? dayjs(assignment.student_deadline).format('MMM D')
        : null;
      const pending = assignment.type === 'REPO' ? (pendingCounts.get(assignment.id) ?? 0) : 0;
      // The column's first cell to grade among the rows shown; a fresh walk
      // starts from the table as it is now.
      const start = (e: React.MouseEvent) => {
        // The header sorts on click; Start must not.
        e.stopPropagation();
        const first = firstInColumn(liveWalkRef.current, assignment.id);
        if (!first) return;
        unfreeze();
        if (first.submissionId === openIdRef.current) rerender();
        else navigate(panelHref(first.submissionId), { preventScrollReset: true });
      };
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
            <span className="text-[11px] font-medium text-ink-3">
              {assignment.weight}%{assignment.is_extra_credit ? ' EC' : ''}
              {due ? ` · due ${due}` : ''}
            </span>
            {pending > 0 && (
              <span className="pt-0.5">
                <button
                  type="button"
                  onClick={start}
                  className="cursor-pointer hover:underline underline-offset-2"
                  data-testid="gradebook-column-start"
                >
                  <Chip tone="blue">{pending} to grade · Start</Chip>
                </button>
              </span>
            )}
          </div>
        ),
        key: `a-${assignment.id}`,
        width: 170,
        sortOrder: sortOrderOf(`a-${assignment.id}`),
        sorter: (a: Student, b: Student) => {
          if (assignment.type === 'QUIZ') {
            // The value the totals count, so the order matches the cells.
            return (quizValueOf(a, assignment.id) ?? -1) - (quizValueOf(b, assignment.id) ?? -1);
          }
          if (assignment.type === 'FORM') {
            const fa = activity.form[assignment.id]?.[a.id]?.submitted ? 1 : 0;
            const fb = activity.form[assignment.id]?.[b.id]?.submitted ? 1 : 0;
            return fa - fb;
          }
          return (gradeOf(a, assignment.id) ?? -1) - (gradeOf(b, assignment.id) ?? -1);
        },
        render: (_: unknown, student: Student) => renderCell(student, assignment),
      };
    };
    const nameColumn: NonNullable<TableProps<Student>['columns']>[number] = isTeams
      ? {
          title: (
            <div className="flex flex-col gap-0.5">
              <span>Team</span>
              <span className="text-[11px] font-medium text-ink-3">
                {teamRows.length} team{teamRows.length === 1 ? '' : 's'}
              </span>
            </div>
          ),
          key: 'student',
          fixed: 'left',
          width: 220,
          sortOrder: sortOrderOf('student'),
          sorter: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
          render: (_: unknown, team) => (
            <div className="flex flex-col min-w-0" data-testid="gradebook-team-row">
              <span className="truncate font-semibold text-ink-1">{team.name}</span>
              <span className="truncate text-xs text-ink-3">
                {(team.members ?? []).map(m => m.name ?? m.login ?? '').join(', ')}
              </span>
            </div>
          ),
        }
      : {
          title: (
            <div className="flex flex-col gap-0.5">
              <span>Student</span>
              <span className="text-[11px] font-medium text-ink-3">{students.length} enrolled</span>
            </div>
          ),
          key: 'student',
          fixed: 'left',
          width: 220,
          sortOrder: sortOrderOf('student'),
          sorter: (a, b) => (a.name ?? a.login ?? '').localeCompare(b.name ?? b.login ?? ''),
          render: (_: unknown, student) => (
            <Link
              to={student.login ? `${base}/students/${student.login}` : '#'}
              className="block hover:underline underline-offset-2"
            >
              <UserThumbnailView user={student} truncate />
            </Link>
          ),
        };

    // The Teams view: team work only, so no totals and no letter.
    const teamColumns: TableProps<Student>['columns'] = [
      nameColumn,
      ...groups.map(group => ({
        title: <span className="font-semibold">{group.title}</span>,
        key: `group-${group.id}`,
        className: 'border-l border-line',
        children: group.items.map(assignment => assignmentColumn(assignment)),
      })),
    ];

    const studentColumns: TableProps<Student>['columns'] = [
      nameColumn,
      ...groups.map(group => {
        const collapsed = collapsedModules.has(group.id);
        const ids = new Set(group.items.map(a => a.id));
        const totalColumn = {
          title: (
            <div className="flex flex-col gap-0.5">
              <span>Module total</span>
              <span className="text-[11px] font-medium text-ink-3">
                {group.items.length} assignment{group.items.length === 1 ? '' : 's'}
              </span>
            </div>
          ),
          key: `module-total-${group.id}`,
          width: 120,
          className: 'bg-stone-50/60 dark:bg-neutral-800/40',
          sortOrder: sortOrderOf(`module-total-${group.id}`),
          sorter: (a: Student, b: Student) =>
            moduleTotalOf(a, group.id, ids) - moduleTotalOf(b, group.id, ids),
          render: (_: unknown, student: Student) => {
            const total = moduleTotalOf(student, group.id, ids);
            return total >= 0 ? (
              <span className="font-semibold tabular-nums">{Math.round(total * 10) / 10}</span>
            ) : (
              <span className="text-ink-4">–</span>
            );
          },
        };
        return {
          title: (
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <button
                type="button"
                onClick={() => toggleModule(group.id)}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand ${group.title}` : `Collapse ${group.title}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-nav-hover hover:text-ink-1"
              >
                {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
              </button>
              {group.title}
            </span>
          ),
          key: `group-${group.id}`,
          className: 'border-l border-line',
          children: collapsed
            ? [totalColumn]
            : [...group.items.map(assignment => assignmentColumn(assignment)), totalColumn],
        };
      }),
      {
        title: (
          <div className="flex flex-col gap-0.5">
            <span>Total</span>
            <span className="text-[11px] font-medium text-ink-3">weighted score</span>
          </div>
        ),
        key: 'total',
        fixed: 'right',
        width: 120,
        className: 'border-l border-line',
        // Highest total first until the viewer sorts otherwise (the sort state's default).
        sortOrder: sortOrderOf('total'),
        sorter: (a, b) => finalOf(a) - finalOf(b),
        render: (_: unknown, student) => {
          const final = finalOf(student);
          if (!(final >= 0)) return <span className="text-ink-4">–</span>;
          const raw = rawOf(student);
          const individual = individualOf(student);
          const tip = (
            <div className="text-xs flex flex-col gap-0.5">
              <span>Before late penalties: {Math.round(raw * 10) / 10}</span>
              <span>
                Individual work only: {individual >= 0 ? Math.round(individual * 10) / 10 : '–'}
              </span>
            </div>
          );
          return (
            <Tooltip title={tip}>
              <span className="font-bold tabular-nums">{Math.round(final * 10) / 10}</span>
            </Tooltip>
          );
        },
      },
      {
        title: (
          <div className="flex flex-col gap-0.5">
            <span>Letter</span>
            <span className="text-[11px] font-medium text-ink-3">from breakpoints</span>
          </div>
        ),
        key: 'letter',
        fixed: 'right',
        width: 100,
        render: (_: unknown, student) => {
          // The student's final grade, by the same function students are shown
          // it with, over the breakpoints as edited here.
          const override = membershipOf(student)?.letter_grade ?? null;
          const input = {
            submissions: student.git_repos.flatMap(repo => repo.assignments ?? []),
            items: itemsOf(student),
            emojiMappings,
            settings,
            letterGradeMappings,
          };
          const letter = finalStudentGrade({ ...input, letterOverride: override })?.letter;
          if (!letter) return <span className="text-ink-4">–</span>;
          const computed = override ? finalStudentGrade(input)?.letter : letter;
          return (
            <Tooltip
              title={
                override
                  ? `Overridden on the student report (computed ${computed ?? '–'})`
                  : undefined
              }
            >
              <span
                className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${
                  override
                    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                    : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300'
                }`}
              >
                {letter}
              </span>
            </Tooltip>
          );
        },
      },
    ];
    return isTeams ? teamColumns : studentColumns;
    // Everything the cells read; the helpers above close over these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    base,
    search,
    groups,
    collapsedModules,
    isTeams,
    teamRows,
    students,
    display,
    sort,
    pendingCounts,
    openRegrades,
    activity,
    emojiMappings,
    settings,
    memberships,
    letterGradeMappings,
  ]);

  // The rows in the order the table shows them, by the same sorter it uses
  // (antd negates it for descend; Array.prototype.sort is stable, as antd's).
  const sortedRows = useMemo(() => {
    const leaves = (cols: TableProps<Student>['columns']): NonNullable<typeof cols> =>
      (cols ?? []).flatMap(c => ('children' in c && c.children ? leaves(c.children) : [c]));
    const sorter = leaves(columns).find(c => c.key === sort.key)?.sorter;
    if (!sort.order || typeof sorter !== 'function') return rows;
    const dir = sort.order === 'descend' ? -1 : 1;
    return [...rows].sort((a, b) => dir * sorter(a, b, sort.order ?? undefined));
  }, [rows, sort, columns]);
  // The grading walk over the table as shown now.
  const liveWalk = useMemo(
    () => walkOrder(sortedRows, walkColumnIds, walkCellOf),
    // walkCellOf reads only openRegrades beyond its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedRows, walkColumnIds, openRegrades]
  );
  liveWalkRef.current = liveWalk;
  // Frozen while the panel is open (see frozenWalkRef), read against the
  // gradebook now: graded cells stay in place, rows that left the filter stay.
  if (!openSubmissionId) frozenWalkRef.current = null;
  else if (!frozenWalkRef.current) frozenWalkRef.current = liveWalk;
  const walk = frozenWalkRef.current
    ? freezeWalk(frozenWalkRef.current, needsGradingNow)
    : liveWalk;
  const outletContext: SubmissionPanelOutletContext = {
    walk,
    emojiMappings,
    gradesHref: `${base}/grades${search}`,
    panelHref,
  };

  // The table's page, held here so the panel can turn to the open cell's.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // Read by the effect below, which runs only when the open cell changes.
  const placement = useRef({ walk, sortedRows, pageSize });
  placement.current = { walk, sortedRows, pageSize };
  useEffect(() => {
    if (!openSubmissionId) return;
    const { walk: cells, sortedRows: shown, pageSize: size } = placement.current;
    const rowId = cells.find(c => c.submissionId === openSubmissionId)?.rowId;
    const index = rowId ? shown.findIndex(r => r.id === rowId) : -1;
    if (index >= 0) setPage(Math.floor(index / size) + 1);
    // Once the page has rendered: bring the cell into view, across too.
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-gradebook-cell="${cssId(openSubmissionId)}"]`)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [openSubmissionId]);

  const summary = useCallback(
    (pageData: readonly Student[]) => {
      const finals = pageData.map(finalOf).filter(g => g >= 0);
      if (finals.length === 0) return null;
      // One summary cell per VISIBLE column, in column order: a collapsed module
      // contributes only its total cell.
      const meanText = (values: number[]) => (values.length ? mean(values).toFixed(1) : '–');
      const summaryCells: { key: string; content: React.ReactNode }[] = groups.flatMap(group => {
        const ids = new Set(group.items.map(a => a.id));
        const assignmentCells = collapsedModules.has(group.id)
          ? []
          : group.items.map(a => {
              if (a.type === 'QUIZ') {
                // Quiz cells are emoji only (E1): the class mean as the nearest
                // emoji on the classroom's scale, the quiz cells' own helper.
                const grades = pageData
                  .map(s => quizValueOf(s, a.id))
                  .filter((g): g is number => g !== null);
                return {
                  key: a.id,
                  content: (
                    <QuizGradeEmoji
                      emoji={
                        grades.length ? quizPercentageEmoji(mean(grades), emojiMappings) : null
                      }
                    />
                  ),
                };
              }
              const grades =
                a.type === 'REPO'
                  ? pageData.map(s => gradeOf(s, a.id)).filter((g): g is number => g !== null)
                  : [];
              return { key: a.id, content: meanText(grades) };
            });
        const totals = pageData.map(s => moduleTotalOf(s, group.id, ids)).filter(t => t >= 0);
        return [...assignmentCells, { key: `module-total-${group.id}`, content: meanText(totals) }];
      });
      return (
        <Table.Summary fixed>
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <span className="text-xs font-semibold text-ink-3">Class</span>
            </Table.Summary.Cell>
            {summaryCells.map((cell, i) => (
              <Table.Summary.Cell key={cell.key} index={i + 1}>
                <span className="text-xs text-ink-2 tabular-nums">{cell.content}</span>
              </Table.Summary.Cell>
            ))}
            <Table.Summary.Cell index={summaryCells.length + 1}>
              <span className="text-xs text-ink-2 whitespace-nowrap">
                mean {mean(finals).toFixed(1)}
                <br />
                median {median(finals).toFixed(1)}
              </span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={summaryCells.length + 2}></Table.Summary.Cell>
          </Table.Summary.Row>
        </Table.Summary>
      );
    },
    // The helpers above close over the scale and settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, collapsedModules, emojiMappings, settings]
  );

  // The table itself, memoized as an element: React skips it while the panel
  // opens and walks, and the open cell's mark is the style rule below.
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const grid = useMemo(
    () => (
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
          scroll={{
            x: isTeams
              ? 220 + columnsSpec.length * 170
              : 440 + (columnsSpec.length + groups.length) * 170,
          }}
          onChange={(pagination, _filters, sorter) => {
            if (pagination.current) setPage(pagination.current);
            if (pagination.pageSize) setPageSize(pagination.pageSize);
            const s = Array.isArray(sorter) ? sorter[0] : sorter;
            const next = { key: String(s?.columnKey ?? ''), order: s?.order ?? null };
            const prev = sortRef.current;
            if (next.key !== prev.key || next.order !== prev.order) {
              unfreeze();
              setSort(next);
            }
          }}
          pagination={{
            current: page,
            pageSize,
            showSizeChanger: true,
            showTotal: (total, range) =>
              `${range[0]}-${range[1]} of ${total} ${isTeams ? 'teams' : 'students'}`,
          }}
          summary={isTeams ? undefined : summary}
          locale={{
            emptyText: (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">
                  {viewRows.length === 0
                    ? 'No students yet'
                    : isTeams
                      ? 'No team matches this filter'
                      : 'Nobody matches this filter'}
                </div>
                <div className="text-sm">
                  {viewRows.length === 0
                    ? 'Students appear here once they join the classroom.'
                    : 'Pick another filter or clear the search.'}
                </div>
              </div>
            ),
          }}
          className="rounded-lg"
        />
      </ConfigProvider>
    ),
    // The handlers inside touch refs and state setters only.
    [rows, columns, summary, isDarkMode, isTeams, columnsSpec, groups, viewRows, page, pageSize]
  );

  return (
    <div className="min-h-full min-w-0">
      {/* The submission panel (child route), handed the walk. */}
      <Outlet context={outletContext} />
      {openSubmissionId && (
        <style>{`[data-gradebook-cell="${cssId(openSubmissionId)}"]{box-shadow:inset 0 0 0 2px var(--accent)}`}</style>
      )}
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <div className="flex items-center gap-3 shrink-0">
          <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Grades</h1>
          {(searchQuery || rowFilter !== 'all') && (
            <span className="text-xs text-ink-3 bg-nav-hover px-2.5 py-1 rounded-full">
              {rows.length} of {viewRows.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 justify-end min-w-0">
          {teamRows.length > 0 && (
            <Segmented<GradebookView>
              size="small"
              value={view}
              onChange={setView}
              options={[
                { value: 'students', label: 'Students' },
                { value: 'teams', label: 'Teams' },
              ]}
              data-testid="gradebook-view-toggle"
            />
          )}
          <Segmented<GradeDisplay>
            size="small"
            value={display}
            onChange={setDisplay}
            options={[
              { value: 'emoji', label: 'Emoji' },
              { value: 'numbers', label: 'Numbers' },
            ]}
            data-testid="gradebook-display-toggle"
          />
          <Input
            placeholder={isTeams ? 'Search teams' : 'Search students'}
            prefix={<IconSearch size={16} />}
            value={searchQuery}
            onChange={e => {
              unfreeze();
              setPage(1);
              setSearchQuery(e.target.value);
            }}
            className="w-52"
            data-tour="grades-search"
          />
          <Select<RowFilter>
            value={rowFilter}
            onChange={next => {
              unfreeze();
              setPage(1);
              setRowFilter(next);
            }}
            className="w-52"
            data-tour="grades-filter"
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'ungraded', label: 'Has something to grade' },
              { value: 'missing', label: 'Has a missing submission' },
              { value: 'late', label: 'Late somewhere' },
            ]}
          />
          <div className="h-6 w-px bg-line" />
          {(canReleaseFinalGrades || finalGradesReleased) && (
            <FinalGradesControl
              released={finalGradesReleased}
              canRelease={canReleaseFinalGrades}
              breakpointsEdited={breakpointsEdited(initialLetterGradeMappings, letterGradeMappings)}
              actionPath={`${base}/grades`}
            />
          )}
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
            {/* A plain link, so the browser downloads the file the route returns. */}
            <a
              href={`${base}/grades/export`}
              download
              data-tour="grades-export"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium whitespace-nowrap text-white bg-accent hover:bg-accent-hover transition-colors"
            >
              <IconDownload size={16} />
              Export CSV
            </a>
          </div>
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden bg-panel ring-1 ring-line min-h-[calc(100vh-10rem)] p-5 sm:p-6">
        {grid}
        <div className="flex items-center gap-4 pt-3 text-xs text-ink-3 flex-wrap">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-amber-50 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-800" />
            Late
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-red-50 ring-1 ring-red-200 dark:bg-red-950/40 dark:ring-red-800" />
            Missing
          </span>
          <span className="flex-1" />
          <span>Click a cell to open the submission. Click a student for their report.</span>
        </div>
      </div>
    </div>
  );
};

export default GradesTable;
