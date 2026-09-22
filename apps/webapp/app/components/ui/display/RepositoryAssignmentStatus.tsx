import { Tag, Tooltip } from 'antd';

interface RepositoryAssignmentStatusProps {
  repositoryAssignment?: {
    status?: 'OPEN' | 'CLOSED' | string;
    /** Submission time: issue closed (ISSUE mode) or latest push (REPO mode). */
    closed_at?: Date | string | null;
    num_late_hours?: number;
    extension_hours?: number;
    is_late_override?: boolean;
    /** Any assignment shape; only `submission_mode` is read here. */
    assignment?: object | null;
  } | null;
  isDropped?: boolean;
}

const RepositoryAssignmentStatus = ({
  repositoryAssignment,
  isDropped,
}: RepositoryAssignmentStatusProps) => {
  const lateHours = repositoryAssignment?.num_late_hours ?? 0;
  const extensionHours = repositoryAssignment?.extension_hours ?? 0;
  const hasLateHours = lateHours > 0;
  const hasExtension = extensionHours > 0;
  const isLateOverride = repositoryAssignment?.is_late_override;
  const isLate = hasLateHours && !isLateOverride;
  // In REPO mode "submitted" means "has pushed"; say when, since a later push
  // (until graded) moves it.
  const isPushMode =
    (repositoryAssignment?.assignment as { submission_mode?: string } | null | undefined)
      ?.submission_mode === 'REPO';
  const submittedAt = repositoryAssignment?.closed_at
    ? new Date(repositoryAssignment.closed_at)
    : null;
  const submittedTip =
    isPushMode && submittedAt
      ? `Last push ${submittedAt.toLocaleString()}`
      : isPushMode
        ? 'A push to the repository is the submission'
        : undefined;

  return (
    <div className="w-full">
      {/* Status Tags */}
      <div className="flex flex-wrap gap-1">
        {repositoryAssignment?.status === 'CLOSED' && (
          <Tooltip title={submittedTip}>
            <Tag color="green" bordered={false}>
              Submitted
            </Tag>
          </Tooltip>
        )}

        {repositoryAssignment?.status === 'OPEN' && (
          <Tooltip title={isPushMode ? 'No push to the repository yet' : undefined}>
            <Tag color="red" bordered={false}>
              Not submitted
            </Tag>
          </Tooltip>
        )}

        {isLate && (
          <Tag color="orange" bordered={false}>
            Late
          </Tag>
        )}

        {hasLateHours && isLateOverride && (
          <Tag color="green" bordered={false}>
            Late Excused
          </Tag>
        )}

        {isDropped && (
          <Tag color="blue" bordered={false}>
            Dropped
          </Tag>
        )}
      </div>

      {/* Late Information - only show if late and not overridden */}
      {isLate && (
        <div className="flex flex-col gap-1 ml-2 mt-3">
          {hasExtension && (
            <p className="text-sm italic text-blue-500">
              {extensionHours} extension hour
              {extensionHours !== 1 ? 's' : ''}
            </p>
          )}
          <p className="text-sm italic text-red-500">
            {lateHours} hour
            {lateHours !== 1 ? 's' : ''} late
          </p>
        </div>
      )}
    </div>
  );
};

export default RepositoryAssignmentStatus;
