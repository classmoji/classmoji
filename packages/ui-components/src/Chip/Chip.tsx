import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

export type ChipVariant = 'quiz' | 'asgn' | 'mod' | 'lab' | 'late' | 'ghost';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant: ChipVariant;
  label?: ReactNode;
  children?: ReactNode;
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { variant, label, children, className, ...rest },
  ref,
) {
  const classes = `chip chip-${variant}${className ? ` ${className}` : ''}`;
  return (
    <span ref={ref} className={classes} {...rest}>
      {children ?? label}
    </span>
  );
});

Chip.displayName = 'Chip';
