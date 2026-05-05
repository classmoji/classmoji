/**
 * Classmoji Logo Component — vector dot-matrix letters with the original
 * raster apple in the "O" slot. Letters scale crisply at any zoom; the apple
 * asset is upscaled 4x so it stays sharp at typical display sizes.
 */

import React from 'react';
import appleImg from '../assets/logo-apple.png';

type SizeKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_HEIGHTS: Record<SizeKey, number> = {
  xs: 16,
  sm: 22,
  md: 32,
  lg: 44,
  xl: 64,
};

const VIEWBOX_W = 279;
const VIEWBOX_H = 51;
const DOT_SIZE = 4;

// Each [x, y] is the top-left of a 4x4 dot. Dots are on a 5px pitch so they
// render with a 1px gap between them — preserving the dot-matrix-printer look.
const LETTER_DOTS: ReadonlyArray<readonly [number, number]> = [
  [5, 12], [10, 12], [15, 12], [0, 17], [20, 17], [0, 22], [0, 27], [0, 32],
  [0, 37], [20, 37], [5, 42], [10, 42], [15, 42], [30, 12], [30, 17], [30, 22],
  [30, 27], [30, 32], [30, 37], [30, 42], [35, 42], [40, 42], [45, 42], [50, 42],
  [65, 12], [70, 12], [75, 12], [60, 17], [80, 17], [60, 22], [80, 22], [60, 27],
  [65, 27], [70, 27], [75, 27], [80, 27], [60, 32], [80, 32], [60, 37], [80, 37],
  [60, 42], [80, 42], [95, 12], [100, 12], [105, 12], [90, 17], [110, 17],
  [90, 22], [95, 27], [100, 27], [105, 27], [110, 32], [90, 37], [110, 37],
  [95, 42], [100, 42], [105, 42], [125, 12], [130, 12], [135, 12], [120, 17],
  [140, 17], [120, 22], [125, 27], [130, 27], [135, 27], [140, 32], [120, 37],
  [140, 37], [125, 42], [130, 42], [135, 42], [150, 12], [170, 12], [150, 17],
  [155, 17], [165, 17], [170, 17], [150, 22], [160, 22], [170, 22], [150, 27],
  [160, 27], [170, 27], [150, 32], [170, 32], [150, 37], [170, 37], [150, 42],
  [170, 42], [230, 12], [235, 12], [240, 12], [240, 17], [240, 22], [240, 27],
  [240, 32], [220, 37], [240, 37], [225, 42], [230, 42], [235, 42], [250, 12],
  [255, 12], [260, 12], [265, 12], [270, 12], [260, 17], [260, 22], [260, 27],
  [260, 32], [260, 37], [250, 42], [255, 42], [260, 42], [265, 42], [270, 42],
];

// Apple slot — sits where the "O" would be in CLASSMOJI, between M and J.
// M's last dots end near x=174 and J's first dots begin at x=220, leaving a
// 46px slot. The original apple asset has a 46x48 native size so this
// preserves its aspect ratio.
const APPLE_X = 174;
const APPLE_Y = -1;
const APPLE_W = 46;
const APPLE_H = 48;
// Stand-alone-icon viewBox covers just the apple slot.
const ICON_VIEWBOX = `${APPLE_X} ${APPLE_Y} ${APPLE_W} ${APPLE_H}`;

const AppleImage = () => (
  <image
    href={appleImg}
    x={APPLE_X}
    y={APPLE_Y}
    width={APPLE_W}
    height={APPLE_H}
    preserveAspectRatio="xMidYMid meet"
  />
);

interface LogoIconProps {
  size?: SizeKey | number;
  className?: string;
}

/**
 * LogoIcon - Just the apple (kept for backward compat).
 */
export const LogoIcon = ({ size = 'md', className = '' }: LogoIconProps): React.JSX.Element => {
  const resolvedHeight = typeof size === 'number' ? size : SIZE_HEIGHTS[size];
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      height={resolvedHeight}
      width="auto"
      className={`inline-block shrink-0 select-none ${className}`}
      role="img"
      aria-label="Classmoji"
    >
      <AppleImage />
    </svg>
  );
};

interface LogoProps {
  variant?: 'full' | 'icon' | 'text';
  size?: SizeKey | number;
  theme?: 'light' | 'dark' | 'current';
  className?: string;
}

/**
 * Logo - Classmoji dot-matrix brand mark, rendered as inline SVG so it stays
 * crisp at any zoom level. The `theme` prop sets the dot color; pass
 * `theme="current"` to inherit the parent's text color via `currentColor`.
 */
export const Logo = ({
  variant = 'full',
  size = 'md',
  theme = 'light',
  className = '',
}: LogoProps): React.JSX.Element => {
  if (variant === 'icon') {
    return <LogoIcon size={size} className={className} />;
  }
  const resolvedHeight = typeof size === 'number' ? size : SIZE_HEIGHTS[size];
  const letterColor =
    theme === 'dark' ? '#ffffff' : theme === 'light' ? '#0d0d10' : 'currentColor';
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      height={resolvedHeight}
      width="auto"
      preserveAspectRatio="xMidYMid meet"
      className={`inline-block shrink-0 select-none ${className}`}
      role="img"
      aria-label="Classmoji"
    >
      <title>Classmoji</title>
      <AppleImage />
      <g fill={letterColor} shapeRendering="crispEdges">
        {LETTER_DOTS.map(([x, y], i) => (
          <rect key={i} x={x} y={y} width={DOT_SIZE} height={DOT_SIZE} />
        ))}
      </g>
    </svg>
  );
};
