import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children?: ReactNode;
}

export function Button({ variant = 'default', className, children, ...rest }: ButtonProps) {
  const variantClass =
    variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : '';
  const classes = ['btn', variantClass, className].filter(Boolean).join(' ');
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
