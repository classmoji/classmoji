import type { ReactNode } from 'react';
import { IconBell, IconCheck } from '../icons/index.tsx';
import type { CalloutVariant } from './types.ts';

export interface VariantConfig {
  defaultAutoDismissMs: number | null;
  /**
   * Colours the icon slot. Everything inside it inherits `currentColor`, which
   * is what draws the spinner ring and the failure badge.
   */
  toneClassName: string;
  defaultIcon: ReactNode;
}

export const VARIANT_CONFIG: Record<CalloutVariant, VariantConfig> = {
  success: {
    defaultAutoDismissMs: 4000,
    toneClassName: 'cm-callout-tone-accent',
    defaultIcon: <IconCheck size={15} />,
  },
  error: {
    defaultAutoDismissMs: null,
    toneClassName: 'cm-callout-tone-rose',
    // A badge rather than a glyph: it carries its own ground, so a failure
    // reads at a glance without the card needing a coloured edge.
    defaultIcon: <span className="cm-callout-badge">!</span>,
  },
  info: {
    defaultAutoDismissMs: null,
    toneClassName: 'cm-callout-tone-sky',
    defaultIcon: <IconBell size={15} />,
  },
  progress: {
    defaultAutoDismissMs: null,
    toneClassName: 'cm-callout-tone-accent',
    // A ring, not an icon: work in flight has no shape of its own.
    defaultIcon: <span className="cm-callout-spinner" />,
  },
};
