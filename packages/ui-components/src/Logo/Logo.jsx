/**
 * Classmoji Logo Component
 */

const SIZE_CLASSES = {
  xs: {
    icon: 'w-5 h-5 text-[12px]',
    text: 'text-sm',
  },
  sm: {
    icon: 'w-7 h-7 text-[17px]',
    text: 'text-xl',
  },
  md: {
    icon: 'w-10 h-10 text-2xl',
    text: 'text-[28px]',
  },
  lg: {
    icon: 'w-14 h-14 text-[34px]',
    text: 'text-[38px]',
  },
  xl: {
    icon: 'w-[72px] h-[72px] text-[43px]',
    text: 'text-5xl',
  },
};

/**
 * LogoIcon - Just the apple emoji
 */
export const LogoIcon = ({ size = 'md', className = '' }) => {
  const isCustomSize = typeof size === 'number';
  const sizeClasses = isCustomSize ? '' : SIZE_CLASSES[size]?.icon || SIZE_CLASSES.md.icon;

  const customStyles = isCustomSize
    ? {
        fontSize: `${size * 0.75}px`,
      }
    : {};

  return (
    <div
      style={customStyles}
      className={`inline-flex items-center justify-center leading-none shrink-0 ${sizeClasses} ${className}`}
      role="img"
      aria-label="Classmoji icon"
    >
      🍎
    </div>
  );
};

/**
 * Logo - Full Classmoji branding with icon and/or text
 *
 * @param {Object} props
 * @param {'full'|'icon'|'text'} props.variant - Display mode (default: 'full')
 * @param {'xs'|'sm'|'md'|'lg'|'xl'|number} props.size - Size preset or custom pixel height (default: 'md')
 * @param {'light'|'dark'} props.theme - Color theme (default: 'light')
 * @param {string} props.className - Optional CSS class for the wrapper
 */
export const Logo = ({ variant = 'full', size = 'md', theme = 'light', className = '' }) => {
  const isCustomSize = typeof size === 'number';
  const showIcon = variant === 'full' || variant === 'icon';
  const showText = variant === 'full' || variant === 'text';

  const textSizeClass = isCustomSize ? '' : SIZE_CLASSES[size]?.text || SIZE_CLASSES.md.text;
  const customTextSize = isCustomSize ? { fontSize: `${Math.round(size * 0.7)}px` } : {};

  const gapClass = showIcon && showText ? 'gap-1.5' : '';
  const themeClass = theme === 'dark' ? 'text-white' : 'text-[#1a1a1a]';

  return (
    <div
      className={`inline-flex items-center ${gapClass} ${className}`}
      role="img"
      aria-label="Classmoji"
    >
      {showIcon && <LogoIcon size={size} />}
      {showText && (
        <span
          style={{
            ...customTextSize,
            fontFamily: 'Noto Sans, sans-serif',
            fontWeight: 800,
          }}
          className={`leading-none lowercase select-none ${textSizeClass} ${themeClass}`}
        >
          classmoji
        </span>
      )}
    </div>
  );
};
