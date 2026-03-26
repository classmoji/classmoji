import {
  applyLatePenalty,
  calculateNumericGrade,
  calculateRepositoryGrade,
  getDroppedRepositoryAssignments,
  isRepositoryAssignmentDropped,
} from '@classmoji/utils';
import type {
  RepositoryAssignment,
  OrganizationSettings,
  GradeEntry,
} from '@classmoji/utils';
import { EmojisDisplay, GradeBadge } from '~/components';
import { Tag, Tooltip } from 'antd';

type EmojiMappings = Record<string, number>;
type ViewMode = string;

/** Extended RepositoryAssignment with fields used in the grades table */
interface GradeRepoAssignment extends RepositoryAssignment {
  assignment_id: string | number;
  assignment: RepositoryAssignment['assignment'] & { title?: string };
}

interface ModuleData {
  id: string | number;
  title: string;
  weight: number;
  is_published: boolean;
  is_extra_credit?: boolean;
  assignments: AssignmentData[];
}

interface AssignmentData {
  id: string | number;
  title: string;
  weight: number;
}

interface ModuleInfo {
  id: string | number;
  title: string;
  weight: number;
  is_extra_credit?: boolean;
  drop_lowest_count?: number;
}

interface StudentRepository {
  module_id: string | number;
  module: ModuleInfo;
  assignments: GradeRepoAssignment[];
}

interface StudentRecord {
  repositories: StudentRepository[];
}

/**
 * Calculates the grade for a specific repository assignment with late penalties applied
 */
const calculateRepositoryAssignmentGrade = (
  repoAssignment: RepositoryAssignment,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings
) => {
  if (!repoAssignment?.grades?.length) return null;

  const emojiGrades = repoAssignment.grades.map(({ emoji }: GradeEntry) => emoji);
  const numericGrade = calculateNumericGrade(emojiGrades, emojiMappings);

  return applyLatePenalty(numericGrade, repoAssignment, settings);
};

/**
 * Renders the grade display based on view mode
 */
const renderGradeCell = (
  repoAssignment: RepositoryAssignment | undefined,
  view: ViewMode,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  isDropped = false
) => {
  if (!repoAssignment) {
    return <span className="text-red-500 italic">None</span>;
  }

  const numericGrade = calculateRepositoryAssignmentGrade(repoAssignment, emojiMappings, settings);

  if (numericGrade === null) {
    return <span className="text-red-500 italic">None</span>;
  }

  const gradeDisplay =
    view === 'Numeric' ? (
      <span className="font-medium">{numericGrade}</span>
    ) : (
      <EmojisDisplay grades={repoAssignment.grades || []} />
    );

  if (isDropped) {
    return (
      <div className="flex items-center gap-2">
        {gradeDisplay}
        <Tag color="blue" bordered={false} className="text-xs">
          Dropped
        </Tag>
      </div>
    );
  }

  return gradeDisplay;
};

/**
 * Creates column definitions for individual assignments within a module
 */
const createRepositoryAssignmentColumns = (
  module: ModuleData,
  view: ViewMode,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  showAssignments: boolean
) => {
  if (!showAssignments) return [];

  return (module.assignments || []).map((assignment: AssignmentData) => ({
    title: `${assignment.title} (${assignment.weight}%)`,
    dataIndex: assignment.title,
    hidden: !showAssignments,
    width: 140,
    ellipsis: true,
    sorter: (a: StudentRecord, b: StudentRecord) => {
      const repoA = a.repositories.find(repo => repo.module_id === module.id);
      const repoB = b.repositories.find(repo => repo.module_id === module.id);

      const repoAssignmentA = repoA?.assignments?.find(
        (ra: GradeRepoAssignment) => ra.assignment_id === assignment.id
      );
      const repoAssignmentB = repoB?.assignments?.find(
        (ra: GradeRepoAssignment) => ra.assignment_id === assignment.id
      );

      const gradeA = repoAssignmentA
        ? calculateRepositoryAssignmentGrade(repoAssignmentA, emojiMappings, settings)
        : -1;
      const gradeB = repoAssignmentB
        ? calculateRepositoryAssignmentGrade(repoAssignmentB, emojiMappings, settings)
        : -1;

      return (gradeA ?? -1) - (gradeB ?? -1);
    },
    render: (_: unknown, student: StudentRecord) => {
      const repository = student.repositories.find(repo => repo.module_id === module.id);

      if (!repository) {
        return <span className="text-red-500 italic">None</span>;
      }

      const repoAssignment = repository.assignments?.find(
        (ra: GradeRepoAssignment) => ra.assignment_id === assignment.id
      );

      // Check if this assignment is dropped for this student
      const dropped = repoAssignment ? isRepositoryAssignmentDropped(
        repoAssignment.id,
        repository.assignments,
        emojiMappings,
        settings,
        repository.module
      ) : false;

      return renderGradeCell(repoAssignment, view, emojiMappings, settings, dropped);
    },
  }));
};

/**
 * Creates the total/average column for a module
 */
const createModuleTotalColumn = (
  module: ModuleData,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  showAssignments: boolean
) => {
  if (!showAssignments) return null;

  return {
    title: 'Average',
    hidden: !showAssignments,
    width: 120,
    ellipsis: true,
    sorter: (a: StudentRecord, b: StudentRecord) => {
      const repoA = a.repositories.find(repo => repo.module_id === module.id);
      const repoB = b.repositories.find(repo => repo.module_id === module.id);

      const gradeA = repoA
        ? calculateRepositoryGrade(repoA.assignments, emojiMappings, settings, repoA.module)
        : -1;
      const gradeB = repoB
        ? calculateRepositoryGrade(repoB.assignments, emojiMappings, settings, repoB.module)
        : -1;

      return gradeA - gradeB;
    },
    render: (_: unknown, student: StudentRecord) => {
      const repository = student.repositories.find(repo => repo.module_id === module.id);

      if (!repository) {
        return <span className="text-red-500 italic">None</span>;
      }

      const grade = calculateRepositoryGrade(
        repository.assignments,
        emojiMappings,
        settings,
        repository.module
      );

      if (grade < 0) return null;

      // Get dropped assignments for this student
      const droppedAssignmentIds = getDroppedRepositoryAssignments(
        repository.assignments,
        emojiMappings,
        settings,
        repository.module
      );
      const hasDroppedAssignments = droppedAssignmentIds.length > 0;

      return (
        <div className="flex items-center gap-2">
          <GradeBadge grade={grade} />
          {hasDroppedAssignments && (
            <Tooltip
              title={
                <div>
                  <div className="font-semibold mb-1">
                    {droppedAssignmentIds.length} assignment
                    {droppedAssignmentIds.length > 1 ? 's' : ''} dropped (lowest score
                    {droppedAssignmentIds.length > 1 ? 's' : ''})
                  </div>
                  <div className="text-xs">
                    {droppedAssignmentIds.map(id => {
                      const repoAssignment = repository.assignments?.find(
                        (ra: GradeRepoAssignment) => ra.id === id
                      );
                      return (
                        <div key={id}>
                          • {repoAssignment?.assignment?.title || 'Unknown assignment'}
                        </div>
                      );
                    })}
                  </div>
                </div>
              }
            >
              <Tag color="purple" bordered={false} className="text-xs">
                {droppedAssignmentIds.length} dropped
              </Tag>
            </Tooltip>
          )}
        </div>
      );
    },
  };
};

/**
 * Creates column definitions for all modules
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Ant Design column types don't include all supported props like `hidden`
export const createAssignmentColumns = (
  modules: ModuleData[],
  view: ViewMode,
  showAssignments: boolean,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings
): any[] => { // eslint-disable-line @typescript-eslint/no-explicit-any -- return type varies based on dynamic column configuration
  return modules
    .filter((module: ModuleData) => module.is_published)
    .map((module: ModuleData) => {
      const assignmentColumns = createRepositoryAssignmentColumns(
        module,
        view,
        emojiMappings,
        settings,
        showAssignments
      );

      const totalColumn = createModuleTotalColumn(module, emojiMappings, settings, showAssignments);

      return {
        title: (
          <span className="font-semibold">
            {module.title} ({module.weight}%)
          </span>
        ),
        align: 'left' as const,
        hidden: false,
        ellipsis: true,
        width: 140,
        children: showAssignments ? [...assignmentColumns, ...(totalColumn ? [totalColumn] : [])] : [],
        sorter: (a: StudentRecord, b: StudentRecord) => {
          const repoA = a.repositories.find(repo => repo.module_id === module.id);
          const repoB = b.repositories.find(repo => repo.module_id === module.id);

          let gradeA = repoA
            ? calculateRepositoryGrade(repoA.assignments, emojiMappings, settings, repoA.module)
            : -1;
          let gradeB = repoB
            ? calculateRepositoryGrade(repoB.assignments, emojiMappings, settings, repoB.module)
            : -1;

          if (module.is_extra_credit) {
            gradeA = gradeA >= 0 ? gradeA * (module.weight / 100) : -1;
            gradeB = gradeB >= 0 ? gradeB * (module.weight / 100) : -1;
          }

          return gradeA - gradeB;
        },
        render: (_: unknown, student: StudentRecord) => {
          const repository = student.repositories.find(repo => repo.module_id === module.id);

          if (!repository) {
            return <span className="text-gray-500 italic">None</span>;
          }

          if (view === 'Emoji') {
            const allGrades = repository.assignments?.flatMap((a: GradeRepoAssignment) => a.grades || []) || [];
            if (allGrades.length === 0) {
              return <span className="text-gray-500 italic">None</span>;
            }
            return <EmojisDisplay grades={allGrades} />;
          }

          let grade = calculateRepositoryGrade(
            repository.assignments,
            emojiMappings,
            settings,
            repository.module
          );

          if (module.is_extra_credit) {
            grade = grade * (module.weight / 100);
          }

          if (grade < 0) return null;

          return (
            <span className="font-medium">
              {module.is_extra_credit ? (
                <span className="text-green-600">+{grade.toFixed(1)}</span>
              ) : (
                <GradeBadge grade={grade} />
              )}
            </span>
          );
        },
      };
    });
};
