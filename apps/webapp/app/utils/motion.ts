// Shared motion language for the webapp.
// One easing curve and a couple of presets so animations across the app move
// with a single voice. Pair these with framer-motion's `useReducedMotion()` so
// nothing moves for users who've opted out of motion.

/** easeOutQuint — the house easing, also used by the onboarding tour. */
export const EASE_OUT_QUINT = [0.22, 1, 0.36, 1] as const;

/** A snappy spring with a touch of overshoot, for "pop" entrances and taps. */
export const POP_SPRING = {
  type: 'spring',
  stiffness: 380,
  damping: 22,
  mass: 0.7,
} as const;

/** A soft spring for entrances that should settle without bouncing. */
export const SOFT_SPRING = {
  type: 'spring',
  stiffness: 260,
  damping: 28,
  mass: 0.9,
} as const;
