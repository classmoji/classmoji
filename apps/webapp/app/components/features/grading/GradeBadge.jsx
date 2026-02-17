const GradeBadge = ({ grade }) => {
  // Handle invalid grades
  if (isNaN(grade) || grade === null || grade === undefined) {
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-500 border border-gray-300">
        No grade
      </span>
    );
  }

  // Determine colors based on grade value
  let bgColor, textColor, borderColor;

  if (grade >= 90) {
    bgColor = 'bg-green-100';
    textColor = 'text-green-700';
    borderColor = 'border-green-300';
  } else if (grade >= 80) {
    bgColor = 'bg-blue-100';
    textColor = 'text-blue-700';
    borderColor = 'border-blue-300';
  } else if (grade >= 70) {
    bgColor = 'bg-yellow-100';
    textColor = 'text-yellow-700';
    borderColor = 'border-yellow-300';
  } else if (grade >= 60) {
    bgColor = 'bg-orange-100';
    textColor = 'text-orange-700';
    borderColor = 'border-orange-300';
  } else {
    bgColor = 'bg-red-100';
    textColor = 'text-red-700';
    borderColor = 'border-red-300';
  }

  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${bgColor} ${textColor} ${borderColor}`}
    >
      {grade.toFixed(1)}%
    </span>
  );
};

export default GradeBadge;
