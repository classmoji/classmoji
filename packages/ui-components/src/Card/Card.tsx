import type { HTMLAttributes, ReactNode, CSSProperties } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  className?: string;
  /** Optional padding override, applied via inline style. */
  padding?: number | string;
}

export function Card({ children, className, padding, style, ...rest }: CardProps) {
  const mergedStyle: CSSProperties | undefined =
    padding !== undefined ? { padding, ...style } : style;
  return (
    <div className={className ? `card ${className}` : 'card'} style={mergedStyle} {...rest}>
      {children}
    </div>
  );
}
