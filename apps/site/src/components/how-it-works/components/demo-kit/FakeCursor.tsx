import React, { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { motion } from 'framer-motion';
import { EASE_OUT, STAGE } from '../../utils/timeline';

type FakeCursorProps = {
  innerRef: RefObject<HTMLDivElement>;
  scale: number;
  target: string | null;
  click: number;
  rest: { x: number; y: number };
  /** changes whenever demo state changes, so the target is re-measured */
  stateKey: unknown;
};

export function FakeCursor({ innerRef, scale, target, click, rest, stateKey }: FakeCursorProps) {
  const [pos, setPos] = useState({ x: STAGE.width * rest.x, y: STAGE.height * rest.y });

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || scale === 0) return;
    let x = STAGE.width * rest.x;
    let y = STAGE.height * rest.y;
    if (target) {
      const el = inner.querySelector<HTMLElement>(`[data-cursor="${target}"]`);
      if (!el) return;
      const ir = inner.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      x = (r.left - ir.left + r.width / 2) / scale;
      y = (r.top - ir.top + r.height / 2) / scale;
    }
    setPos((p) => (Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5 ? p : { x, y }));
  }, [innerRef, target, stateKey, scale, rest.x, rest.y]);

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 z-50"
      initial={false}
      animate={{ x: pos.x, y: pos.y }}
      transition={{
        x: { duration: 0.6, ease: [0.45, 0, 0.2, 1] },
        y: { duration: 0.6, ease: [0.25, 0, 0.35, 1] },
      }}
    >
      {click > 0 && (
        <motion.span
          key={`ripple-${click}`}
          className="absolute -left-4 -top-4 h-8 w-8 rounded-full bg-accent/25 ring-2 ring-accent"
          initial={{ scale: 0.3, opacity: 0.9 }}
          animate={{ scale: 1.35, opacity: 0 }}
          transition={{ duration: 0.45, ease: EASE_OUT }}
        />
      )}
      <motion.svg
        key={`press-${click}`}
        width="18"
        height="22"
        viewBox="0 0 18 22"
        className="relative drop-shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
        style={{ originX: 0.1, originY: 0.08 }}
        initial={{ scale: click > 0 ? 0.82 : 1 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
      >
        <path
          d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.6-1.1-2.8-6.5h6z"
          className="fill-ink-0 stroke-white dark:fill-white dark:stroke-ink-0"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </motion.svg>
    </motion.div>
  );
}
