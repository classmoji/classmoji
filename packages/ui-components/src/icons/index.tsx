/**
 * Icon library for Classmoji redesign.
 *
 * Ported verbatim from the design bundle (common.jsx). All icons default to
 * 16px at stroke width 1.75. `github`, `dot`, and `logo` are filled — they
 * preserve the source's stroke/fill behavior.
 *
 * Two export shapes are provided for convenience:
 *   - Named components: `IconHome`, `IconCalendar`, …
 *   - `Icon` object with kebab-cased source keys: `Icon.home`, `Icon.checkSquare`
 */

import type { SVGProps } from 'react';

export interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

type SvgRest = Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'strokeWidth'>;

type AnyIconProps = IconProps & SvgRest;

const DEFAULT_SIZE = 16;
const DEFAULT_STROKE = 1.75;

export function IconHome({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function IconCalendar({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

export function IconCheck({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconCheckSquare({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  );
}

export function IconModule({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconFile({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

export function IconArrowRotate({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M3 12a9 9 0 0 1 14.5-7" />
      <path d="M21 5v5h-5" />
      <path d="M21 12a9 9 0 0 1-14.5 7" />
      <path d="M3 19v-5h5" />
    </svg>
  );
}

export function IconCoin({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9 10h5a1.5 1.5 0 0 1 0 3h-4a1.5 1.5 0 0 0 0 3h5" />
    </svg>
  );
}

export function IconBook({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 19a2 2 0 0 0 2 2h13" />
    </svg>
  );
}

export function IconSettings({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function IconDocs({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

export function IconSupport({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1 1-1 1.7M12 17h.01" />
    </svg>
  );
}

export function IconChevron({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconChevronR({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconArrowR({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconGithub({ size = DEFAULT_SIZE, strokeWidth: _strokeWidth, ...rest }: AnyIconProps) {
  void _strokeWidth;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.69c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}

export function IconSearch({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconBell({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function IconPlus({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconSparkle({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.5 5.5l2.8 2.8M15.7 15.7l2.8 2.8M18.5 5.5l-2.8 2.8M8.3 15.7l-2.8 2.8" />
    </svg>
  );
}

export function IconDiamond({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="m3 9 3-6h12l3 6-9 12z" />
      <path d="M3 9h18M8 9l4 12M16 9l-4 12" />
    </svg>
  );
}

export function IconClock({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconPeople({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" />
      <circle cx="17" cy="9" r="3" />
      <path d="M15 15c3 0 6 2 6 5" />
    </svg>
  );
}

export function IconMessage({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M21 12a8 8 0 0 1-11 7.4L3 21l1.6-7A8 8 0 1 1 21 12z" />
    </svg>
  );
}

export function IconTerminal({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="m4 7 5 5-5 5M12 17h8" />
    </svg>
  );
}

export function IconDot({ size = DEFAULT_SIZE, strokeWidth: _strokeWidth, ...rest }: AnyIconProps) {
  void _strokeWidth;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconX({ size = DEFAULT_SIZE, strokeWidth = DEFAULT_STROKE, ...rest }: AnyIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function IconLogo({ size = 24, strokeWidth: _strokeWidth, ...rest }: AnyIconProps) {
  void _strokeWidth;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" {...rest}>
      <path d="M16 7c3 0 5 2 5 2s-1-3.5-3-4.5 1-2 1-2-3 0-5 2.5C12 2.5 9 2.5 9 2.5s2 1 1 2-3 1.5-3 4.5c0 0 2-2 5-2 0 0-5 3.5-5 10 0 7 5 11 9 11s9-4 9-11c0-6.5-5-10-5-10z" fill="oklch(62% 0.19 285)" />
      <circle cx="12.5" cy="14" r="1.2" fill="white" />
      <circle cx="19.5" cy="14" r="1.2" fill="white" />
      <path d="M12 19c1 1.2 2.3 1.8 4 1.8s3-.6 4-1.8" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Drop-in-compat object mirroring the design bundle's `Icon` namespace.
 * Keys match the source verbatim (kebab-cased): `Icon.home`, `Icon.checkSquare`, …
 */
export const Icon = {
  home: IconHome,
  calendar: IconCalendar,
  check: IconCheck,
  checkSquare: IconCheckSquare,
  module: IconModule,
  file: IconFile,
  arrowRotate: IconArrowRotate,
  coin: IconCoin,
  book: IconBook,
  settings: IconSettings,
  docs: IconDocs,
  support: IconSupport,
  chevron: IconChevron,
  chevronR: IconChevronR,
  arrowR: IconArrowR,
  github: IconGithub,
  search: IconSearch,
  bell: IconBell,
  plus: IconPlus,
  sparkle: IconSparkle,
  diamond: IconDiamond,
  clock: IconClock,
  people: IconPeople,
  message: IconMessage,
  terminal: IconTerminal,
  dot: IconDot,
  x: IconX,
  logo: IconLogo,
} as const;
