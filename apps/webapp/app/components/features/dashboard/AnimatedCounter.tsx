import { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  value: number | string;
  suffix?: string;
  format?: (n: number) => string;
  durationMs?: number;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

const AnimatedCounter = ({
  value,
  suffix,
  format,
  durationMs = 700,
}: AnimatedCounterProps) => {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const [display, setDisplay] = useState<number>(isNumber ? 0 : 0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isNumber) return;
    const target = value as number;
    const start = performance.now();

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      setDisplay(target * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(target);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, isNumber, durationMs]);

  if (!isNumber) {
    return <span className="font-mono">{value}</span>;
  }

  const target = value as number;
  const isInt = Number.isInteger(target);
  const formatted = format
    ? format(display)
    : isInt
      ? Math.round(display).toLocaleString()
      : display.toFixed(1);

  return (
    <span className="font-mono tabular-nums">
      {formatted}
      {suffix ?? ''}
    </span>
  );
};

export default AnimatedCounter;
