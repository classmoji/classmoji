import type { CalloutVariant } from './types.ts';

export interface VariantConfig {
  defaultAutoDismissMs: number | null;
  accentClassName: string;
  iconColorClassName: string;
}

export const VARIANT_CONFIG: Record<CalloutVariant, VariantConfig> = {
  success: {
    defaultAutoDismissMs: 4000,
    accentClassName: 'bg-emerald-500',
    iconColorClassName: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-rose-500',
    iconColorClassName: 'text-rose-600 dark:text-rose-400',
  },
  info: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-sky-500',
    iconColorClassName: 'text-sky-600 dark:text-sky-400',
  },
  progress: {
    defaultAutoDismissMs: null,
    accentClassName: 'bg-violet-500',
    iconColorClassName: 'text-violet-600 dark:text-violet-400',
  },
};
