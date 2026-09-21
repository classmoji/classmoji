/**
 * The small coloured block a month cell and the all-day strip draw for one
 * event.
 *
 * The DOM shape is deliberate and is the shape every calendar block now has: a
 * NON-interactive container with the event's own `<button>` inside it as one
 * child among siblings. Resource links land beside that button later, and a
 * link nested inside a button is not a thing a browser can render — so the
 * container is where nesting happens and the button is a leaf.
 *
 * The staff block used to be a bare `<div onClick>`: unreachable by keyboard,
 * invisible to a screen reader, and impossible to focus. It is a real button
 * for both roles now.
 */

import type { ReactNode } from 'react';
import { getEventTypeDarkText, getEventTypeLightBg } from './utils';
import type { CalendarEventWithLinks } from './types';

interface EventChipProps {
  event: CalendarEventWithLinks;
  onClick?: (event: CalendarEventWithLinks) => void;
  /**
   * A second line under the title — a deadline's `due 11:59 PM`. Kept a slot
   * rather than derived so the strip and the month cell can differ without the
   * chip growing a mode flag.
   */
  subtitle?: ReactNode;
  /** A hint for the pointer, e.g. "Drag to change deadline" on a staff block. */
  title?: string;
  /** Cursor and grab affordances the drag layer adds; purely visual. */
  className?: string;
}

const EventChip = ({ event, onClick, subtitle, title, className = '' }: EventChipProps) => {
  const type = event.is_deadline ? 'DEADLINE' : (event.event_type ?? 'OTHER');

  return (
    <div
      title={title}
      className={`relative rounded-md min-w-0 ${getEventTypeLightBg(type)} ${getEventTypeDarkText(
        type
      )} ${
        // Staff see unpublished items; the dashed outline is what says so.
        event.is_unpublished ? 'border border-dashed border-yellow-500' : ''
      } ${className}`}
    >
      <button
        type="button"
        onClick={() => onClick?.(event)}
        // An inset outline, not a ring: the chip fills a month cell that clips
        // its overflow, so anything drawn outside the button's own box would be
        // painted into that clip and never seen.
        className="block w-full text-left px-1.5 py-1 rounded-md min-w-0 hover:opacity-80 transition-opacity focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex items-center gap-1 min-w-0">
          <span className="text-xs font-medium leading-tight truncate">{event.title}</span>
          {event.is_unpublished && (
            <span className="shrink-0 text-xs px-1 rounded bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200">
              Draft
            </span>
          )}
        </span>
        {subtitle && (
          <span className="block text-xs opacity-80 leading-tight truncate">{subtitle}</span>
        )}
      </button>
    </div>
  );
};

export default EventChip;
