import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode, CSSProperties } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  className?: string;
  /** Optional padding override, applied via inline style. */
  padding?: number | string;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { children, className, padding, style, ...rest },
  ref,
) {
  const mergedStyle: CSSProperties | undefined =
    padding !== undefined ? { padding, ...style } : style;
  return (
    <div
      ref={ref}
      className={className ? `card ${className}` : 'card'}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </div>
  );
});

Card.displayName = 'Card';
