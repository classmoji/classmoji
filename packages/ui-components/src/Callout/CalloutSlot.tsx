import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CalloutCard } from './CalloutCard.tsx';
import { useCalloutSlotInternal } from './CalloutProvider.tsx';

const DEFAULT_SLOT_ID = 'default';

export interface CalloutSlotProps {
  id?: string;
  className?: string;
}

function cn(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(' ');
}

export function CalloutSlot({
  id = DEFAULT_SLOT_ID,
  className,
}: CalloutSlotProps) {
  const { active, registerSlot, unregisterSlot, dismiss } =
    useCalloutSlotInternal(id);
  const reducedMotion = useReducedMotion();

  // Latest dispatcher refs so the mount/unmount effect can stay [] without
  // capturing stale closures (registerSlot/unregisterSlot identities change
  // on every provider tick).
  const registerRef = useRef(registerSlot);
  const unregisterRef = useRef(unregisterSlot);
  useEffect(() => {
    registerRef.current = registerSlot;
    unregisterRef.current = unregisterSlot;
  }, [registerSlot, unregisterSlot]);

  // Register exactly once on mount, unregister exactly once on unmount.
  useEffect(() => {
    registerRef.current();
    return () => {
      unregisterRef.current();
    };
  }, []);

  const initial = reducedMotion
    ? { opacity: 0, y: 0 }
    : { opacity: 0, y: -8 };
  const exit = reducedMotion ? { opacity: 0, y: 0 } : { opacity: 0, y: -4 };

  return (
    <div className={cn('w-full', className)}>
      <AnimatePresence mode="wait">
        {active ? (
          <motion.div
            key={active.id}
            initial={initial}
            animate={{ opacity: 1, y: 0 }}
            exit={exit}
            transition={{ duration: 0.18, ease: 'easeOut' }}
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
