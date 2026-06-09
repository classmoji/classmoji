import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', className, children, ...rest },
  ref
) {
  const variantClass =
    variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : '';
  const classes = ['btn', variantClass, className].filter(Boolean).join(' ');
  return (
    <button ref={ref} className={classes} {...rest}>
      {children}
    </button>
  );
});

Button.displayName = 'Button';
