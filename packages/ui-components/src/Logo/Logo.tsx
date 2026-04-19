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
  const sizeClasses = isCustomSize
    ? ''
    : SIZE_CLASSES[size as SizeKey]?.icon || SIZE_CLASSES.md.icon;

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

// ============================================================
// Pixel-dot wordmark — ported from design bundle (wordmark.jsx)
// Each letter is a 5-wide × 7-tall dot grid; an apple SVG
// replaces the "O" between the M and J.
// ============================================================

const GLYPHS: Record<string, string[]> = {
  C: ['.1111', '1....', '1....', '1....', '1....', '1....', '.1111'],
  L: ['1....', '1....', '1....', '1....', '1....', '1....', '11111'],
  A: ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  S: ['.1111', '1....', '1....', '.111.', '....1', '....1', '1111.'],
  M: ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
  J: ['...11', '....1', '....1', '....1', '....1', '1...1', '.111.'],
  I: ['11111', '..1..', '..1..', '..1..', '..1..', '..1..', '11111'],
};

const Glyph = ({
  char,
  dot,
  gap,
  color,
}: {
  char: keyof typeof GLYPHS;
  dot: number;
  gap: number;
  color: string;
}) => {
  const grid = GLYPHS[char];
  const cell = dot + gap;
  const w = 5 * cell - gap;
  const h = 7 * cell - gap;
  const dots: React.ReactElement[] = [];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (grid[r][c] === '1') {
        dots.push(
          <rect
            key={`${r}-${c}`}
            x={c * cell}
            y={r * cell}
            width={dot}
            height={dot}
            rx={dot * 0.18}
            fill={color}
          />,
        );
      }
    }
  }
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: 'block', flexShrink: 0 }}
    >
      {dots}
    </svg>
  );
};

const AppleGlyph = ({ height }: { height: number }) => {
  const w = Math.round(height * 0.95);
  return (
    <svg
      width={w}
      height={height}
      viewBox="6 0 90 100"
      style={{ display: 'block', flexShrink: 0, transform: 'translateY(-8%)' }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="cm-appleBody" cx="38%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#ff7b6b" />
          <stop offset="40%" stopColor="#e63340" />
          <stop offset="85%" stopColor="#a3121d" />
          <stop offset="100%" stopColor="#6f0511" />
        </radialGradient>
        <radialGradient id="cm-appleHi" cx="32%" cy="28%" r="28%">
          <stop offset="0%" stopColor="rgba(255,240,230,0.85)" />
          <stop offset="100%" stopColor="rgba(255,240,230,0)" />
        </radialGradient>
        <linearGradient id="cm-leafGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4fb355" />
          <stop offset="60%" stopColor="#2d8a3b" />
          <stop offset="100%" stopColor="#155b25" />
        </linearGradient>
        <linearGradient id="cm-stemGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#7b4a28" />
          <stop offset="100%" stopColor="#3e2414" />
        </linearGradient>
      </defs>
      <path
        d="M51 20 C 33 10, 10 20, 10 48 C 10 75, 30 96, 51 96 C 72 96, 92 75, 92 48 C 92 20, 69 10, 51 20 Z"
        fill="url(#cm-appleBody)"
      />
      <path
        d="M51 22 C 49 30, 49 40, 51 50 C 53 40, 53 30, 51 22 Z"
        fill="rgba(0,0,0,0.22)"
      />
      <ellipse cx="51" cy="22" rx="7" ry="4" fill="rgba(0,0,0,0.35)" />
      <ellipse cx="34" cy="38" rx="14" ry="20" fill="url(#cm-appleHi)" />
      <path
        d="M51 22 C 54 14, 58 8, 62 4"
        stroke="url(#cm-stemGrad)"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M62 10 C 74 4, 86 8, 88 18 C 82 22, 70 22, 62 14 Z"
        fill="url(#cm-leafGrad)"
      />
      <path
        d="M64 14 C 72 14, 80 16, 86 18"
        stroke="rgba(0,0,0,0.25)"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
};

// Letter-height (px) per size key.
const WORDMARK_HEIGHT: Record<SizeKey, number> = {
  xs: 14,
  sm: 18,
  md: 22,
  lg: 28,
  xl: 36,
};

const Wordmark = ({
  height,
  color,
}: {
  height: number;
  color: string;
}): React.JSX.Element => {
  const cell = height / 7;
  const gap = Math.max(1, Math.round(cell * 0.22));
  const dot = Math.max(2, Math.round(cell - gap));
  const appleH = Math.round(height * 1.28);
  const letterGap = Math.max(2, Math.round(dot * 0.55));
  const appleNudge = -Math.round(dot * 0.9);
  const letters: Array<keyof typeof GLYPHS> = ['C', 'L', 'A', 'S', 'S', 'M'];
  const tail: Array<keyof typeof GLYPHS> = ['J', 'I'];
  return (
    <div
      className="wordmark"
      style={{ display: 'inline-flex', alignItems: 'center', gap: `${letterGap}px` }}
      role="img"
      aria-label="Classmoji"
    >
      {letters.map((c, i) => (
        <Glyph key={`l-${i}`} char={c} dot={dot} gap={gap} color={color} />
      ))}
      <span style={{ width: appleNudge, display: 'inline-block' }} />
      <AppleGlyph height={appleH} />
      <span style={{ width: appleNudge, display: 'inline-block' }} />
      {tail.map((c, i) => (
        <Glyph key={`t-${i}`} char={c} dot={dot} gap={gap} color={color} />
      ))}
    </div>
  );
};

/**
 * Logo - Pixel-dot CLASSMOJI wordmark with apple-as-O.
 * `variant="icon"` still renders just the apple emoji (used for compact spots).
 */
export const Logo = ({
  variant = 'full',
  size = 'md',
  theme = 'light',
  className = '',
}: LogoProps): React.JSX.Element => {
  const isCustomSize = typeof size === 'number';
  const letterHeight = isCustomSize
    ? Math.max(10, Math.round((size as number) * 0.78))
    : WORDMARK_HEIGHT[size as SizeKey] ?? WORDMARK_HEIGHT.md;

  const color =
    theme === 'current'
      ? 'currentColor'
      : theme === 'dark'
        ? '#ffffff'
        : 'var(--ink-0, #14151a)';

  if (variant === 'icon') {
    return <LogoIcon size={size} className={className} />;
  }

  return (
    <div
      className={`inline-flex items-center ${className}`}
      role="img"
      aria-label="Classmoji"
    >
      <Wordmark height={letterHeight} color={color} />
    </div>
  );
};
