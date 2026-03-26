import { Tag } from 'antd';

const RepositoryAssignmentStatus = ({ repositoryAssignment, isDropped }: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- accepts various Prisma repository assignment shapes
  const hasLateHours = repositoryAssignment?.num_late_hours > 0;
  const hasExtension = repositoryAssignment?.extension_hours > 0;
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
              {repositoryAssignment.extension_hours} extension hour
              {repositoryAssignment.extension_hours !== 1 ? 's' : ''}
            </p>
          )}
          <p className="text-sm italic text-red-500">
            {repositoryAssignment.num_late_hours} hour
            {repositoryAssignment.num_late_hours !== 1 ? 's' : ''} late
          </p>
        </div>
      )}
    </div>
  );
};

export default RepositoryAssignmentStatus;
