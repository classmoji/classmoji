import type { ReactNode } from 'react';
import { IconArrowRotate, IconBell, IconCheck, IconX } from '../icons/index.tsx';
import type { CalloutVariant } from './types.ts';

export interface VariantConfig {
  defaultAutoDismissMs: number | null;
  accentClassName: string;
  iconColorClassName: string;
  defaultIcon: ReactNode;
}

export const VARIANT_CONFIG: Record<CalloutVariant, VariantConfig> = {
  success: {
    defaultAutoDismissMs: 4000,
    accentClassName: 'bg-emerald-500',
    iconColorClassName: 'text-emerald-600 dark:text-emerald-400',
    defaultIcon: <IconCheck size={18} />,
  },
  error: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-rose-500',
    iconColorClassName: 'text-rose-600 dark:text-rose-400',
    defaultIcon: <IconX size={18} />,
  },
  info: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-sky-500',
    iconColorClassName: 'text-sky-600 dark:text-sky-400',
    defaultIcon: <IconBell size={18} />,
  },
  progress: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-violet-500',
    iconColorClassName: 'text-violet-600 dark:text-violet-400',
    defaultIcon: (
      <IconArrowRotate size={18} className="animate-spin" style={{ animationDuration: '1.6s' }} />
    ),
  },
};
