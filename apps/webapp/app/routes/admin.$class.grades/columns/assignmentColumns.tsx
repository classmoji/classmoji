import { calculateAssignmentGrade } from '@classmoji/utils';
import type { GitRepoAssignment, OrganizationSettings } from '@classmoji/utils';
import { EmojisDisplay, GradeBadge } from '~/components';
import { Tag } from 'antd';
import { Link } from 'react-router';
import type { TableProps } from 'antd';

type EmojiMappings = Record<string, number>;
type ViewMode = string;

/** Extended GitRepoAssignment with fields used in the grades table */
interface GradeRepoAssignment extends GitRepoAssignment {
  assignment_id: string | number;
  assignment: GitRepoAssignment['assignment'] & { id?: string | number; title?: string };
}

/** A module, as the gradebook loader hands it over: one column group. */
export interface GradebookModule {
  id: string;
  title: string;
  position: number;
}

/** A published assignment, flat, with the module it belongs to. */
export interface GradebookAssignment {
  id: string;
  title: string;
  weight: number;
  is_extra_credit: boolean;
  type: string;
  module_id: string;
  repository_id?: string | null;
}

interface StudentGitRepo {
  repository_id: string | number;
  assignments: GradeRepoAssignment[];
}

interface StudentRecord {
  git_repos: StudentGitRepo[];
}

/** The student's submission row for an assignment, wherever its git repo sits. */
const findSubmission = (student: StudentRecord, assignmentId: string) => {
  for (const repo of student.git_repos) {
    const found = repo.assignments?.find(
      (ra: GradeRepoAssignment) => String(ra.assignment_id ?? ra.assignment?.id) === assignmentId
    );
    if (found) return found;
  }
  return undefined;
};

/**
 * Weighted mean of a student's graded submissions in one module. Extra credit
 * is kept out of the mean and reported separately so the collapsed module
 * column can show it as "+x", the way the course grade treats it.
 */
const moduleSummary = (
  student: StudentRecord,
  assignments: GradebookAssignment[],
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings
) => {
  let weighted = 0;
  let totalWeight = 0;
  let extraCredit = 0;
  const grades: GitRepoAssignment['grades'] = [];

  for (const assignment of assignments) {
    const submission = findSubmission(student, assignment.id);
    if (!submission) continue;
    grades.push(...(submission.grades ?? []));
    const grade = calculateAssignmentGrade(submission, emojiMappings, settings);
    if (grade === null) continue;
    if (assignment.is_extra_credit) {
      extraCredit += (grade * assignment.weight) / 100;
    } else {
      weighted += grade * assignment.weight;
      totalWeight += assignment.weight;
    }
  }

  return {
    mean: totalWeight > 0 ? Math.round((weighted / totalWeight) * 10) / 10 : null,
    extraCredit,
    grades,
  };
};

const NONE = <span className="text-red-500 italic">None</span>;

/** Renders the grade display for one submission based on view mode */
const renderGradeCell = (
  submission: GitRepoAssignment | undefined,
  view: ViewMode,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings
) => {
  if (!submission) return NONE;

  const numericGrade = calculateAssignmentGrade(submission, emojiMappings, settings);
  if (numericGrade === null) return NONE;

  return view === 'Numeric' ? (
    <span className="font-medium">{numericGrade}</span>
  ) : (
    <EmojisDisplay grades={submission.grades || []} />
  );
};

/** One column per assignment inside a module group */
const createModuleAssignmentColumns = (
  assignments: GradebookAssignment[],
  view: ViewMode,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  assignmentHref?: (assignmentId: string) => string
) =>
  assignments.map(assignment => ({
    title: (
      <span className="inline-flex items-center gap-1">
        {assignmentHref ? (
          <Link
            to={assignmentHref(String(assignment.id))}
            className="hover:underline underline-offset-2"
          >
            {assignment.title}
          </Link>
        ) : (
          assignment.title
        )}{' '}
        ({assignment.weight}%)
        {assignment.is_extra_credit && (
          <Tag color="green" bordered={false} className="text-xs m-0">
            EC
          </Tag>
        )}
      </span>
    ),
    key: `assignment-${assignment.id}`,
    width: 140,
    ellipsis: true,
    sorter: (a: StudentRecord, b: StudentRecord) => {
      const subA = findSubmission(a, assignment.id);
      const subB = findSubmission(b, assignment.id);
      const gradeA = subA ? calculateAssignmentGrade(subA, emojiMappings, settings) : null;
      const gradeB = subB ? calculateAssignmentGrade(subB, emojiMappings, settings) : null;
      return (gradeA ?? -1) - (gradeB ?? -1);
    },
    render: (_: unknown, student: StudentRecord) =>
      renderGradeCell(findSubmission(student, assignment.id), view, emojiMappings, settings),
  }));

/**
 * Column groups for the gradebook: one group per module (only modules with at
 * least one published REPO assignment), one child column per assignment.
 * Collapsed, the group column shows the module's weighted mean (or every
 * emoji in the Emoji view); expanded, it shows the per-assignment columns.
 */
export const createAssignmentColumns = (
  modules: GradebookModule[],
  assignments: GradebookAssignment[],
  view: ViewMode,
  showAssignments: boolean,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  /** Where an assignment's header links (its page); none = plain text. */
  assignmentHref?: (assignmentId: string) => string
): TableProps<StudentRecord>['columns'] => {
  // Quiz/form assignments are structural only for now: they carry no grade.
  const graded = assignments.filter(a => a.type === 'REPO');

  return [...modules]
    .sort((a, b) => a.position - b.position)
    .map(module => ({ module, assignments: graded.filter(a => a.module_id === module.id) }))
    .filter(({ assignments: moduleAssignments }) => moduleAssignments.length > 0)
    .map(({ module, assignments: moduleAssignments }) => ({
      title: <span className="font-semibold">{module.title}</span>,
      key: `module-${module.id}`,
      align: 'left' as const,
      hidden: false,
      ellipsis: true,
      width: 140,
      children: showAssignments
        ? createModuleAssignmentColumns(
            moduleAssignments,
            view,
            emojiMappings,
            settings,
            assignmentHref
          )
        : [],
      sorter: (a: StudentRecord, b: StudentRecord) => {
        const sumA = moduleSummary(a, moduleAssignments, emojiMappings, settings);
        const sumB = moduleSummary(b, moduleAssignments, emojiMappings, settings);
        return (sumA.mean ?? -1) + sumA.extraCredit - ((sumB.mean ?? -1) + sumB.extraCredit);
      },
      render: (_: unknown, student: StudentRecord) => {
        const summary = moduleSummary(student, moduleAssignments, emojiMappings, settings);

        if (view === 'Emoji') {
          if (summary.grades.length === 0) {
            return <span className="text-gray-500 italic">None</span>;
          }
          return <EmojisDisplay grades={summary.grades} />;
        }

        if (summary.mean === null && summary.extraCredit === 0) return null;

        return (
          <span className="inline-flex items-center gap-2 font-medium">
            {summary.mean !== null && <GradeBadge grade={summary.mean} />}
            {summary.extraCredit > 0 && (
              <span className="text-green-600">+{summary.extraCredit.toFixed(1)}</span>
            )}
          </span>
        );
      },
    }));
};
