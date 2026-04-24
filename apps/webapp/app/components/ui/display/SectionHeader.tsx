const titleSizeClasses: Record<string, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

const subtitleSizeClasses: Record<string, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-sm',
};

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  count?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SectionHeader = ({
  title,
  subtitle,
  count,
  size = 'lg',
  className = '',
}: SectionHeaderProps) => (
  <div className={`flex items-center gap-3 ${className}`}>
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
      <span className="bg-stone-100 dark:bg-neutral-800 text-gray-600 dark:text-gray-300 text-sm font-medium rounded-full h-6 w-6 flex items-center justify-center">
        {count}
      </span>
    )}
  </div>
);

export default SectionHeader;
