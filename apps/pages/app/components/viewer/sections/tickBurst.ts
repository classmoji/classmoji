import { playBurst } from '@classmoji/ui-components/click-burst';

/**
 * The burst a tick box gives when the reader ticks it on: the click burst
 * every control gives (`@classmoji/ui-components/click-burst`), centred on the
 * box rather than the pointer.
 *
 * Fired by the reader's own tick, on a checkable heading's box
 * (sectionCheckbox.ts) and a student check list item (personalCheckListItem.ts).
 * Never on untick, never from an inert box ("View as"), never when the reader
 * prefers reduced motion. Both boxes carry `data-no-burst`, so the click burst
 * leaves them to this one. Drawn in the burst colour (`--pg-burst`: the
 * reader's check colour, lighter in dark mode).
 */

/**
 * Play the burst on `anchor` (the box just ticked on). Returns a promise that
 * settles when the burst is gone, or null when none plays.
 */
export function tickBurst(anchor: Element): Promise<void> | null {
  if (typeof document === 'undefined') return null;
  const rect = anchor.getBoundingClientRect();
  const style = getComputedStyle(anchor);
  const color =
    style.getPropertyValue('--pg-burst').trim() ||
    style.getPropertyValue('--pg-primary').trim() ||
    'currentColor';
  return playBurst(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    color,
    anchor.ownerDocument
  );
}
