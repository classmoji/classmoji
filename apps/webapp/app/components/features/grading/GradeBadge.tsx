interface GradeBadgeProps {
  grade: number | null | undefined;
}

const GradeBadge = ({ grade }: GradeBadgeProps) => {
  if (grade === null || grade === undefined || isNaN(grade)) {
    return <span className="text-sm text-ink-4">—</span>;
  }

  return (
    <span className="text-sm font-medium text-ink-1 tabular-nums">
      {grade.toFixed(1)}%
    </span>
  );
};

export default GradeBadge;
