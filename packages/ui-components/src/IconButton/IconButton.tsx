import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** Accessible label / tooltip text. Used for both `title` and `aria-label`. */
  label: string;
  icon: ReactNode;
}

/**
 * Ghost-styled icon button for topbar utilities (GitHub, bell, settings, etc.).
 */
export function IconButton({ label, icon, className, ...rest }: IconButtonProps) {
  const classes = ['btn', 'btn-ghost', className].filter(Boolean).join(' ');
  return (
    <button className={classes} title={label} aria-label={label} {...rest}>
      {icon}
    </button>
  );
}
