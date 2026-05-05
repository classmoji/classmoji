import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CalloutCard } from './CalloutCard.tsx';
import {
  DEFAULT_CALLOUT_SLOT_ID,
  useCalloutSlotInternal,
} from './CalloutProvider.tsx';

export interface CalloutSlotProps {
  id?: string;
  className?: string;
}

export function CalloutSlot({
  id = DEFAULT_CALLOUT_SLOT_ID,
  className,
}: CalloutSlotProps) {
  const { active, registerSlot, unregisterSlot, dismiss } =
    useCalloutSlotInternal(id);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    registerSlot();
    return unregisterSlot;
    // registerSlot/unregisterSlot read the latest provider context internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initial = reducedMotion
    ? { opacity: 0, y: 0, scale: 1 }
    : { opacity: 0, y: -24, scale: 0.96 };
  const animate = { opacity: 1, y: 0, scale: 1 };
  const exit = reducedMotion
    ? { opacity: 0, y: 0, scale: 1 }
    : { opacity: 0, y: -16, scale: 0.98 };

  const enterTransition = reducedMotion
    ? { duration: 0.15, ease: 'easeOut' as const }
    : {
        type: 'spring' as const,
        stiffness: 380,
        damping: 30,
        mass: 0.8,
        opacity: { duration: 0.18, ease: 'easeOut' as const },
      };
  const exitTransition = {
    duration: 0.2,
    ease: [0.4, 0, 1, 1] as [number, number, number, number],
  };

  const baseClass =
    'pointer-events-none fixed top-4 left-1/2 z-50 w-full max-w-2xl -translate-x-1/2 px-4';
  const wrapperClass = className ? `${baseClass} ${className}` : baseClass;

  return (
    <div className={wrapperClass}>
      <AnimatePresence mode="popLayout">
        {active ? (
          <motion.div
            key={active.id}
            initial={initial}
            animate={animate}
            exit={{ ...exit, transition: exitTransition }}
            transition={enterTransition}
            style={{ transformOrigin: 'top center', willChange: 'transform, opacity' }}
            className="pointer-events-auto"
          >
            <CalloutCard
              payload={active}
              onDismiss={() => dismiss(active.id)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
