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
    ? { opacity: 0, y: 0 }
    : { opacity: 0, y: -8 };
  const exit = reducedMotion ? { opacity: 0, y: 0 } : { opacity: 0, y: -4 };

  const baseClass =
    'pointer-events-none fixed top-4 left-1/2 z-50 w-full max-w-2xl -translate-x-1/2 px-4';
  const wrapperClass = className ? `${baseClass} ${className}` : baseClass;

  return (
    <div className={wrapperClass}>
      <AnimatePresence>
        {active ? (
          <motion.div
            key={active.id}
            initial={initial}
            animate={{ opacity: 1, y: 0 }}
            exit={exit}
            transition={{ duration: 0.18, ease: 'easeOut' }}
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
