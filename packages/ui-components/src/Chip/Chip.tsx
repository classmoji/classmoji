import type { HTMLAttributes, ReactNode } from 'react';

export type ChipVariant = 'quiz' | 'asgn' | 'mod' | 'lab' | 'late' | 'ghost';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant: ChipVariant;
  label?: ReactNode;
  children?: ReactNode;
}

export function Chip({ variant, label, children, className, ...rest }: ChipProps) {
  const classes = `chip chip-${variant}${className ? ` ${className}` : ''}`;
  return (
    <span className={classes} {...rest}>
      {children ?? label}
    </span>
  );
}
