import {
  applyLatePenalty,
  calculateNumericGrade,
  calculateRepositoryGrade,
  getDroppedRepositoryAssignments,
  isRepositoryAssignmentDropped,
} from '@classmoji/utils';
import type { GitRepoAssignment, OrganizationSettings, GradeEntry } from '@classmoji/utils';
import { EmojisDisplay, GradeBadge } from '~/components';
import { Tag, Tooltip } from 'antd';
import type { TableProps } from 'antd';

type EmojiMappings = Record<string, number>;
type ViewMode = string;

/** Extended GitRepoAssignment with fields used in the grades table */
interface GradeRepoAssignment extends GitRepoAssignment {
  assignment_id: string | number;
  assignment: GitRepoAssignment['assignment'] & { title?: string };
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
  repository_id: string | number;
  repository: ModuleInfo;
  assignments: GradeRepoAssignment[];
}

interface StudentRecord {
  repositories: StudentRepository[];
}

/**
 * Calculates the grade for a specific repository assignment with late penalties applied
 */
const calculateRepositoryAssignmentGrade = (
  repoAssignment: GitRepoAssignment,
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
  repoAssignment: GitRepoAssignment | undefined,
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
 * Creates column definitions for individual assignments within a repository
 */
const createRepositoryAssignmentColumns = (
  repository: ModuleData,
  view: ViewMode,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings,
  showAssignments: boolean
) => {
  if (!showAssignments) return [];

  return (repository.assignments || []).map((assignment: AssignmentData) => ({
    title: `${assignment.title} (${assignment.weight}%)`,
    dataIndex: assignment.title,
    hidden: !showAssignments,
    width: 140,
    ellipsis: true,
    sorter: (a: StudentRecord, b: StudentRecord) => {
      const repoA = a.repositories.find(repo => repo.repository_id === repository.id);
      const repoB = b.repositories.find(repo => repo.repository_id === repository.id);

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
      const studentRepo = student.repositories.find(repo => repo.repository_id === repository.id);

      if (!studentRepo) {
        return <span className="text-red-500 italic">None</span>;
      }

      const repoAssignment = studentRepo.assignments?.find(
        (ra: GradeRepoAssignment) => ra.assignment_id === assignment.id
      );

      // Check if this assignment is dropped for this student
      const dropped = repoAssignment
        ? isRepositoryAssignmentDropped(
            repoAssignment.id,
            studentRepo.assignments,
            emojiMappings,
            settings,
            studentRepo.repository
          )
        : false;

      return renderGradeCell(repoAssignment, view, emojiMappings, settings, dropped);
    },
  }));
};

/**
 * Creates the total/average column for a repository
 */
const createModuleTotalColumn = (
  repository: ModuleData,
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
      const repoA = a.repositories.find(repo => repo.repository_id === repository.id);
      const repoB = b.repositories.find(repo => repo.repository_id === repository.id);

      const gradeA = repoA
        ? calculateRepositoryGrade(repoA.assignments, emojiMappings, settings, repoA.repository)
        : -1;
      const gradeB = repoB
        ? calculateRepositoryGrade(repoB.assignments, emojiMappings, settings, repoB.repository)
        : -1;

      return gradeA - gradeB;
    },
    render: (_: unknown, student: StudentRecord) => {
      const studentRepo = student.repositories.find(repo => repo.repository_id === repository.id);

      if (!studentRepo) {
        return <span className="text-red-500 italic">None</span>;
      }

      const grade = calculateRepositoryGrade(
        studentRepo.assignments,
        emojiMappings,
        settings,
        studentRepo.repository
      );

      if (grade < 0) return null;

      // Get dropped assignments for this student
      const droppedAssignmentIds = getDroppedRepositoryAssignments(
        studentRepo.assignments,
        emojiMappings,
        settings,
        studentRepo.repository
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
                      const repoAssignment = studentRepo.assignments?.find(
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
 * Creates column definitions for all repositories
 */

export const createAssignmentColumns = (
  repositories: ModuleData[],
  view: ViewMode,
  showAssignments: boolean,
  emojiMappings: EmojiMappings,
  settings: OrganizationSettings
): TableProps<StudentRecord>['columns'] => {
  return repositories
    .filter((repository: ModuleData) => repository.is_published)
    .map((repository: ModuleData) => {
      const assignmentColumns = createRepositoryAssignmentColumns(
        repository,
        view,
        emojiMappings,
        settings,
        showAssignments
      );

      const totalColumn = createModuleTotalColumn(repository, emojiMappings, settings, showAssignments);

      return {
        title: (
          <span className="font-semibold">
            {repository.title} ({repository.weight}%)
          </span>
        ),
        align: 'left' as const,
        hidden: false,
        ellipsis: true,
        width: 140,
        children: showAssignments
          ? [...assignmentColumns, ...(totalColumn ? [totalColumn] : [])]
          : [],
        sorter: (a: StudentRecord, b: StudentRecord) => {
          const repoA = a.repositories.find(repo => repo.repository_id === repository.id);
          const repoB = b.repositories.find(repo => repo.repository_id === repository.id);

          let gradeA = repoA
            ? calculateRepositoryGrade(repoA.assignments, emojiMappings, settings, repoA.repository)
            : -1;
          let gradeB = repoB
            ? calculateRepositoryGrade(repoB.assignments, emojiMappings, settings, repoB.repository)
            : -1;

          if (repository.is_extra_credit) {
            gradeA = gradeA >= 0 ? gradeA * (repository.weight / 100) : -1;
            gradeB = gradeB >= 0 ? gradeB * (repository.weight / 100) : -1;
          }

          return gradeA - gradeB;
        },
        render: (_: unknown, student: StudentRecord) => {
          const studentRepo = student.repositories.find(repo => repo.repository_id === repository.id);

          if (!studentRepo) {
            return <span className="text-gray-500 italic">None</span>;
          }

          if (view === 'Emoji') {
            const allGrades =
              studentRepo.assignments?.flatMap((a: GradeRepoAssignment) => a.grades || []) || [];
            if (allGrades.length === 0) {
              return <span className="text-gray-500 italic">None</span>;
            }
            return <EmojisDisplay grades={allGrades} />;
          }

          let grade = calculateRepositoryGrade(
            studentRepo.assignments,
            emojiMappings,
            settings,
            studentRepo.repository
          );

          if (repository.is_extra_credit) {
            grade = grade * (repository.weight / 100);
          }

          if (grade < 0) return null;

          return (
            <span className="font-medium">
              {repository.is_extra_credit ? (
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
