/**
 * @classmoji/ui-components
 *
 * Shared UI components for classmoji applications.
 */

// Logo components
export { Logo, LogoIcon } from './Logo/index.ts';

// Sandpack components
export {
  SandpackEmbed,
  SandpackRenderer,
  SandpackBlock,
  useSandpackSync,
  parseFromHtml,
  serializeToHtml,
  SANDPACK_TEMPLATES,
  SANDPACK_THEMES,
  SANDPACK_LAYOUTS,
  DEFAULT_FILES,
} from './Sandpack/index.ts';

// Design-system primitives (Phase 2 redesign)
export { Card } from './Card/index.ts';
export type { CardProps } from './Card/index.ts';

export { Chip } from './Chip/index.ts';
export type { ChipProps, ChipVariant } from './Chip/index.ts';

export { Button } from './Button/index.ts';
export type { ButtonProps, ButtonVariant } from './Button/index.ts';

export { Avatar } from './Avatar/index.ts';
export type { AvatarProps } from './Avatar/index.ts';

export { Breadcrumb } from './Breadcrumb/index.ts';
export type { BreadcrumbProps } from './Breadcrumb/index.ts';

export { StatusBadge } from './StatusBadge/index.ts';
export type { StatusBadgeProps, StatusState } from './StatusBadge/index.ts';

export { EmojiScale } from './EmojiScale/index.ts';
export type { EmojiScaleProps, EmojiGrade } from './EmojiScale/index.ts';

export { IconButton } from './IconButton/index.ts';
export type { IconButtonProps } from './IconButton/index.ts';

// Icon library
export {
  Icon,
  IconHome,
  IconCalendar,
  IconCheck,
  IconCheckSquare,
  IconModule,
  IconFile,
  IconArrowRotate,
  IconCoin,
  IconBook,
  IconSettings,
  IconDocs,
  IconSupport,
  IconChevron,
  IconChevronR,
  IconArrowR,
  IconGithub,
  IconSearch,
  IconBell,
  IconPlus,
  IconSparkle,
  IconDiamond,
  IconClock,
  IconPeople,
  IconMessage,
  IconTerminal,
  IconDot,
  IconX,
  IconLogo,
} from './icons/index.tsx';
export type { IconProps } from './icons/index.tsx';
