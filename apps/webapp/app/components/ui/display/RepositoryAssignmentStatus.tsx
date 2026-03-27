import { Tag } from 'antd';

interface RepositoryAssignmentStatusProps {
  repositoryAssignment?: {
    status?: 'OPEN' | 'CLOSED' | string;
    num_late_hours?: number;
    extension_hours?: number;
    is_late_override?: boolean;
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

  return (
    <div className="w-full">
      {/* Status Tags */}
      <div className="flex flex-wrap gap-1">
        {repositoryAssignment?.status === 'CLOSED' && (
          <Tag color="green" bordered={false}>
            Submitted
          </Tag>
        )}

        {repositoryAssignment?.status === 'OPEN' && (
          <Tag color="red" bordered={false}>
            Not submitted
          </Tag>
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
