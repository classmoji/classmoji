interface GradeBadgeProps {
  grade: number | null | undefined;
}

const GradeBadge = ({ grade }: GradeBadgeProps) => {
  if (grade === null || grade === undefined || isNaN(grade)) {
    return <span className="text-sm text-gray-400 dark:text-gray-500">—</span>;
  }

  return (
    <span className="text-sm font-medium text-gray-800 dark:text-gray-200 tabular-nums">
      {grade.toFixed(1)}%
    </span>
  );
};

export default GradeBadge;
