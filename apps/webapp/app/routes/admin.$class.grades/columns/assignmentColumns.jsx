import {
  calculateNumericGrade,
  calculateRepositoryGrade,
  getDroppedRepositoryAssignments,
  isRepositoryAssignmentDropped,
} from '@classmoji/utils';
import { EmojisDisplay, GradeBadge } from '~/components';
import { Tag, Tooltip } from 'antd';

/**
 * Calculates the grade for a specific repository assignment with late penalties applied
 */
const calculateRepositoryAssignmentGrade = (repoAssignment, emojiMappings, settings) => {
  if (!repoAssignment?.grades?.length) return null;

  const emojiGrades = repoAssignment.grades.map(({ emoji }) => emoji);
  let numericGrade = calculateNumericGrade(emojiGrades, emojiMappings);

  // Apply late penalty if applicable
  if (repoAssignment.num_late_hours > 0 && !repoAssignment.is_late_override) {
    const totalLateHours = repoAssignment.num_late_hours + repoAssignment.extension_hours;
    numericGrade -= totalLateHours * settings.late_penalty_points_per_hour;
  }

  return Math.max(0, numericGrade);
};

/**
 * Renders the grade display based on view mode
 */
const renderGradeCell = (repoAssignment, view, emojiMappings, settings, isDropped = false) => {
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
const createRepositoryAssignmentColumns = (module, view, emojiMappings, settings, showAssignments) => {
  if (!showAssignments) return [];

  return (module.assignments || []).map(assignment => ({
    title: `${assignment.title} (${assignment.weight}%)`,
    dataIndex: assignment.title,
    hidden: !showAssignments,
    ellipsis: true,
    sorter: (a, b) => {
      const repoA = a.repositories.find(repo => repo.module_id === module.id);
      const repoB = b.repositories.find(repo => repo.module_id === module.id);

      const repoAssignmentA = repoA?.assignments?.find(ra => ra.assignment_id === assignment.id);
      const repoAssignmentB = repoB?.assignments?.find(ra => ra.assignment_id === assignment.id);

      const gradeA = repoAssignmentA ? calculateRepositoryAssignmentGrade(repoAssignmentA, emojiMappings, settings) : -1;
      const gradeB = repoAssignmentB ? calculateRepositoryAssignmentGrade(repoAssignmentB, emojiMappings, settings) : -1;

      return (gradeA ?? -1) - (gradeB ?? -1);
    },
    render: (_, student) => {
      const repository = student.repositories.find(repo => repo.module_id === module.id);

      if (!repository) {
        return <span className="text-red-500 italic">None</span>;
      }

      const repoAssignment = repository.assignments?.find(ra => ra.assignment_id === assignment.id);

      // Check if this assignment is dropped for this student
      const dropped = isRepositoryAssignmentDropped(
        repoAssignment?.id,
        repository.assignments,
        emojiMappings,
        settings,
        repository.module
      );

      return renderGradeCell(repoAssignment, view, emojiMappings, settings, dropped);
    },
  }));
};

/**
 * Creates the total/average column for a module
 */
const createModuleTotalColumn = (module, emojiMappings, settings, showAssignments) => {
  if (!showAssignments) return null;

  return {
    title: 'Average',
    hidden: !showAssignments,
    ellipsis: true,
    sorter: (a, b) => {
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
    render: (_, student) => {
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
                    {droppedAssignmentIds.length} assignment{droppedAssignmentIds.length > 1 ? 's' : ''} dropped
                    (lowest score{droppedAssignmentIds.length > 1 ? 's' : ''})
                  </div>
                  <div className="text-xs">
                    {droppedAssignmentIds.map(id => {
                      const repoAssignment = repository.assignments?.find(ra => ra.id === id);
                      return <div key={id}>• {repoAssignment?.assignment?.title || 'Unknown assignment'}</div>;
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
export const createAssignmentColumns = (modules, view, showAssignments, emojiMappings, settings) => {
  return modules
    .filter(module => module.is_published)
    .map(module => {
      const assignmentColumns = createRepositoryAssignmentColumns(
        module,
        view,
        emojiMappings,
        settings,
        showAssignments
      );

      const totalColumn = createModuleTotalColumn(
        module,
        emojiMappings,
        settings,
        showAssignments
      );

      return {
        title: (
          <span className="font-semibold">
            {module.title} ({module.weight}%)
          </span>
        ),
        align: 'left',
        ellipsis: true,
        width: 140,
        children: showAssignments ? [...assignmentColumns, totalColumn] : [],
        sorter: (a, b) => {
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
        render: (_, student) => {
          const repository = student.repositories.find(
            repo => repo.module_id === module.id
          );

          if (!repository) {
            return <span className="text-gray-500 italic">None</span>;
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
