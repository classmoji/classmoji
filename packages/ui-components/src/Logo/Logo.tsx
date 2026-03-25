/**
 * Classmoji Logo Component
 */

import React from 'react';

type SizeKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<SizeKey, { icon: string; text: string }> = {
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

interface LogoIconProps {
  size?: SizeKey | number;
  className?: string;
}

/**
 * LogoIcon - Just the apple emoji
 */
export const LogoIcon = ({ size = 'md', className = '' }: LogoIconProps): React.JSX.Element => {
  const isCustomSize = typeof size === 'number';
  const sizeClasses = isCustomSize ? '' : SIZE_CLASSES[size as SizeKey]?.icon || SIZE_CLASSES.md.icon;

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

interface LogoProps {
  variant?: 'full' | 'icon' | 'text';
  size?: SizeKey | number;
  theme?: 'light' | 'dark' | 'current';
  className?: string;
}

/**
 * Logo - Full Classmoji branding with icon and/or text
 */
export const Logo = ({ variant = 'full', size = 'md', theme = 'light', className = '' }: LogoProps): React.JSX.Element => {
  const isCustomSize = typeof size === 'number';
  const showIcon = variant === 'full' || variant === 'icon';
  const showText = variant === 'full' || variant === 'text';

  const textSizeClass = isCustomSize ? '' : SIZE_CLASSES[size as SizeKey]?.text || SIZE_CLASSES.md.text;
  const customTextSize = isCustomSize ? { fontSize: `${Math.round(size * 0.7)}px` } : {};

  const gapClass = showIcon && showText ? 'gap-1.5' : '';
  const themeClass =
    theme === 'current'
      ? 'text-current'
      : theme === 'dark'
        ? 'text-white'
        : 'text-[#1a1a1a] dark:text-white';

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
