import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CalloutCard } from './CalloutCard.tsx';
import { DEFAULT_CALLOUT_SLOT_ID, useCalloutSlotInternal } from './CalloutProvider.tsx';

export interface CalloutSlotProps {
  id?: string;
  className?: string;
}

export function CalloutSlot({ id = DEFAULT_CALLOUT_SLOT_ID, className }: CalloutSlotProps) {
  const { active, registerSlot, unregisterSlot, dismiss } = useCalloutSlotInternal(id);
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
  const exit = reducedMotion ? { opacity: 0, y: 0, scale: 1 } : { opacity: 0, y: -16, scale: 0.98 };

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

  const baseClass = 'pointer-events-none fixed left-1/2 w-full -translate-x-1/2 px-4';
  const wrapperClass = className ? `${baseClass} ${className}` : baseClass;

  return (
    // top and zIndex are set inline (not via Tailwind classes) so they apply even
    // though this shared package's source isn't scanned by the consumer's Tailwind
    // build: a utility no app file happens to use (e.g. `top-20`) is never emitted,
    // and the slot would sit flush against the top of the viewport.
    //
    // Most screens have nothing fixed at the top, so the callout sits just below
    // the viewport edge. A layout with a sticky header raises it by setting
    // `--callout-top` (the app's user header does, to clear its 82px). z 60 keeps
    // the callout above such a header (z-50) and below antd modals (z-1000+).
    <div
      className={wrapperClass}
      // No max-width here: the card sets its own 420px and centres itself, so
      // this only has to span the viewport and keep a gutter at phone width.
      // `px-4` is a rem, which is 17px in the webapp, so pinning the wrapper
      // instead would make the card 418 in one app and 420 in another.
      style={{ top: 'var(--callout-top, 24px)', zIndex: 60 }}
    >
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
            <CalloutCard payload={active} onDismiss={() => dismiss(active.id)} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
