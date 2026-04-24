interface ClassMarkProps {
  hue: number;
  name: string;
  size?: number;
}

export function ClassMark({ hue, name, size = 28 }: ClassMarkProps) {
  const initials = (name.replace(/[^A-Z0-9]/gi, '').slice(0, 3) || '??')
    .toUpperCase()
    .slice(0, 2);
  return (
    <span
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 6,
        display: 'grid',
        placeItems: 'center',
        color: 'white',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 700,
        background: `linear-gradient(135deg, oklch(72% 0.14 ${hue}), oklch(55% 0.19 ${hue}))`,
      }}
    >
      {initials}
    </span>
  );
}
