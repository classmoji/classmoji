import { Switch, Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';
import {
  ASSIGNMENT_TYPE_META,
  type AssignmentRowData,
} from '~/components/features/assignments/AssignmentsTable';

interface AssignmentsCardProps {
  assignments: AssignmentRowData[];
  /** Submitted count per assignment id, computed from the student repos. */
  submittedById: Record<string, number>;
  totalRepos: number;
  onEdit: (assignment: AssignmentRowData) => void;
  onToggleGradesReleased: (assignmentId: string, released: boolean) => void;
  /**
   * False for a read-only viewer (an assistant): the row still reports how many
   * submitted and whether grades are out, but neither can be changed here.
   */
  canEdit?: boolean;
}

/**
 * The assignments that submit through this repository, one line each: where
 * it lives, how students submit, when it is due, how many have, and whether
 * grades are visible. Assignments are created from the module card, not here.
 */
const AssignmentsCard = ({
  assignments,
  submittedById,
  totalRepos,
  onEdit,
  onToggleGradesReleased,
  canEdit = true,
}: AssignmentsCardProps) => {
  const Icon = ASSIGNMENT_TYPE_META.REPO.icon;
  return (
    <div className="rounded-2xl bg-panel ring-1 ring-line px-5 py-4 flex flex-col gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">
        Assignments through this repo
      </div>
      {assignments.length === 0 ? (
        <p className="text-sm text-ink-3 py-2">
          None yet. Add an assignment from a module and pick this repository to make it gradable.
        </p>
      ) : (
        assignments.map(a => (
          <div
            key={a.id}
            className="flex items-center gap-4 rounded-lg bg-stone-50 dark:bg-neutral-800/60 px-3 py-2"
          >
            <Icon size={18} className="text-gray-400 shrink-0" />
            <span className="font-semibold text-ink-1 truncate">{a.title}</span>
            <span className="text-xs text-ink-3 whitespace-nowrap">
              {a.module.title} · Repo · {a.submission_mode === 'REPO' ? 'push' : 'issue'}
            </span>
            <span className="flex-1" />
            <span className="text-sm text-ink-3 whitespace-nowrap">
              {a.student_deadline
                ? `Due ${dayjs(a.student_deadline).format('MMM D, h:mm A')}`
                : 'No deadline'}
            </span>
            <span className="text-sm font-medium text-ink-1 tabular-nums whitespace-nowrap">
              {submittedById[a.id] ?? 0} / {totalRepos} submitted
            </span>
            {canEdit ? (
              <Tooltip title="When on, students can see their grades for this assignment.">
                <label className="flex items-center gap-2 text-xs text-ink-2 whitespace-nowrap cursor-pointer">
                  <Switch
                    size="small"
                    checked={a.grades_released}
                    onChange={checked => onToggleGradesReleased(a.id, checked)}
                  />
                  Grades released
                </label>
              </Tooltip>
            ) : (
              a.grades_released && (
                <span className="text-xs text-ink-2 whitespace-nowrap">Grades released</span>
              )
            )}
            <Tag color={a.is_published ? 'green' : 'orange'} className="m-0 shrink-0 font-medium">
              {a.is_published ? 'Published' : 'Draft'}
            </Tag>
            {canEdit && (
              <button
                type="button"
                onClick={() => onEdit(a)}
                className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
              >
                Edit
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
};

export default AssignmentsCard;
