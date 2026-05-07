import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** Accessible label / tooltip text. Used for both `title` and `aria-label`. */
  label: string;
  icon: ReactNode;
}

/**
 * Ghost-styled icon button for topbar utilities (GitHub, bell, settings, etc.).
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, ...rest },
  ref
) {
  const classes = ['btn', 'btn-ghost', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} className={classes} title={label} aria-label={label} {...rest}>
      {icon}
    </button>
  );
});

IconButton.displayName = 'IconButton';
