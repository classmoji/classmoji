/**
 * Classmoji Logo Component
 */

import React from 'react';
import logoPixel from '../assets/logo-pixel.png';

type SizeKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_HEIGHTS: Record<SizeKey, number> = {
  xs: 16,
  sm: 22,
  md: 32,
  lg: 44,
  xl: 64,
};

interface LogoIconProps {
  size?: SizeKey | number;
  className?: string;
}

/**
 * LogoIcon - Just the apple emoji (kept for backward compat)
 */
export const LogoIcon = ({ size = 'md', className = '' }: LogoIconProps): React.JSX.Element => {
  const resolvedHeight = typeof size === 'number' ? size : SIZE_HEIGHTS[size];
  return (
    <img
      src={logoPixel}
      alt="Classmoji"
      style={{ height: resolvedHeight, width: 'auto', objectFit: 'contain' }}
      className={`inline-block shrink-0 select-none ${className}`}
      draggable={false}
    />
  );
};

interface LogoProps {
  variant?: 'full' | 'icon' | 'text';
  size?: SizeKey | number;
  theme?: 'light' | 'dark' | 'current';
  className?: string;
}

/**
 * Logo - Classmoji pixel-art brand mark.
 * Uses the raster logo asset so the pixel glyphs stay crisp across sizes.
 */
export const Logo = ({
  variant: _variant = 'full',
  size = 'md',
  theme: _theme = 'light',
  className = '',
}: LogoProps): React.JSX.Element => {
  const resolvedHeight = typeof size === 'number' ? size : SIZE_HEIGHTS[size];
  return (
    <img
      src={logoPixel}
      alt="Classmoji"
      style={{
        height: resolvedHeight,
        width: 'auto',
        objectFit: 'contain',
        imageRendering: 'pixelated',
      }}
      className={`inline-block shrink-0 select-none ${className}`}
      draggable={false}
    />
  );
};
