const sizeClasses = {
  sm: 'h-4',
  md: 'h-5',
  lg: 'h-6',
};

const titleSizeClasses = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

const subtitleSizeClasses = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-sm',
};

const SectionHeader = ({ title, subtitle, count, size = 'lg', className = '' }) => (
  <div className={`flex items-center gap-3 ${className}`}>
    <div
      className={`w-1 ${sizeClasses[size]} bg-primary-400 dark:bg-primary-500 rounded-full`}
    ></div>
    <div>
      <h3 className={`${titleSizeClasses[size]} font-semibold text-gray-900 dark:text-gray-100`}>
        {title}
      </h3>
      {subtitle && (
        <p className={`${subtitleSizeClasses[size]} text-gray-600 dark:text-gray-400`}>
          {subtitle}
        </p>
      )}
    </div>
    {count !== undefined && (
      <span className="bg-primary-100 dark:bg-primary-900/30 text-white dark:text-primary-400 text-sm font-medium rounded-full h-6 w-6 flex items-center justify-center">
        {count}
      </span>
    )}
  </div>
);

export default SectionHeader;
