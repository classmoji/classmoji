import type { CSSProperties, HTMLAttributes } from 'react';

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  initials?: string;
  hue?: number;
  size?: number;
  /** Optional image source. When provided, renders an <img> instead of initials. */
  src?: string;
  alt?: string;
}

const DEFAULT_HUE = 285;
const DEFAULT_SIZE = 24;

export function Avatar({
  initials,
  hue = DEFAULT_HUE,
  size = DEFAULT_SIZE,
  src,
  alt,
  className,
  style,
  ...rest
}: AvatarProps) {
  const baseStyle: CSSProperties = {
    background: `linear-gradient(135deg, oklch(82% 0.09 ${hue}), oklch(60% 0.18 ${hue}))`,
    width: size,
    height: size,
    fontSize: size * 0.42,
    ...style,
  };

  const classes = className ? `avatar ${className}` : 'avatar';

  if (src) {
    return (
      <span
        className={classes}
        style={{ ...baseStyle, overflow: 'hidden', padding: 0 }}
        {...rest}
      >
        <img
          src={src}
          alt={alt ?? initials ?? ''}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
        />
      </span>
    );
  }

  return (
    <span className={classes} style={baseStyle} {...rest}>
      {initials ?? ''}
    </span>
  );
}
