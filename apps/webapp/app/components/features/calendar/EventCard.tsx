import type { ReactNode } from 'react';
import { ClockCircleOutlined, EnvironmentOutlined, VideoCameraOutlined } from '@ant-design/icons';
import {
  formatTime,
  formatTimeRange,
  getEventTypeBorderColor,
  getEventTypeLabel,
  getEventDuration,
  formatDuration,
  isEventNow,
  getEventTypeLightBg,
  getEventTypeDarkText,
} from './utils';
import type { CalendarEventWithLinks } from './types';

/** Types whose block says where it is. A deadline has no room. */
const TYPES_WITH_A_ROOM = ['OFFICE_HOURS', 'LECTURE', 'LAB'];

interface EventCardProps {
  event: CalendarEventWithLinks;
  onClick?: (event: CalendarEventWithLinks) => void;
  showCreator?: boolean;
  compact?: boolean;
  /**
   * Compact only: whether the block is tall enough for the meta row under the
   * title. The caller decides with `geometry.fitsMetaRow`, because it is the
   * one that knows how tall it made the block. Default true — the drag overlay
   * and anything else without a slot to fit has nothing to clip against.
   */
  showMeta?: boolean;
}

/**
 * One event, as a block in the week grid (`compact`) or as the body of the
 * detail modal.
 *
 * The card is a NON-interactive container holding the event's own `<button>`.
 * It used to be a `<div onClick>`, which no keyboard could reach and no screen
 * reader announced; and it has to stay a container rather than become a button
 * itself, because resource links sit beside that button later and an anchor
 * inside a button is not renderable. With no `onClick` — the modal, the drag
 * overlay — there is nothing to press, so no button is rendered at all.
 */
const EventCard = ({
  event,
  onClick,
  showCreator = false,
  compact = false,
  showMeta = true,
}: EventCardProps) => {
  const isHappeningNow = isEventNow(event);
  const duration = getEventDuration(event);
  const padding = compact ? 'p-2' : 'p-3';

  /**
   * Where the event is, for the compact block: the word Virtual for a meeting
   * link, otherwise the room — and only for the types that HAVE a room. A
   * deadline or an assessment says nothing here.
   */
  const place = TYPES_WITH_A_ROOM.includes(event.event_type)
    ? event.meeting_link
      ? 'Virtual'
      : (event.location ?? null)
    : null;
  const metaText = `${formatTimeRange(event.start_time, event.end_time)}${
    place ? ` · ${place}` : ''
  }`;

  /**
   * A compact card fills the block the grid sized for it, so a two-hour event
   * draws two hours tall and a 45-minute one stops before the next block. It
   * was content-height, which made every block the same size whatever its
   * duration — harmless while only the staff grid used it, a regression for
   * students the moment both views shared it.
   *
   * `min-h-0` on the flex child is what lets `overflow-hidden` actually clip:
   * a flex item's default `min-height: auto` refuses to shrink below its
   * content, so the text would push out of the bottom of the card instead.
   */
  const fill = compact ? 'h-full flex flex-col min-h-0' : '';
  const fillChild = compact ? 'flex-1 min-h-0 overflow-hidden' : '';

  const body: ReactNode = (
    // A tighter gap in a block than in the modal: at an hour tall, the two
    // lines and the space between them have about 6px to spare.
    <div className={compact ? 'space-y-0.5 min-h-0' : 'space-y-1.5'}>
      {/* Title */}
      <div
        className={`font-medium ${getEventTypeDarkText(event.event_type)} ${
          compact ? 'text-sm' : 'text-base'
        } line-clamp-1 flex items-center gap-2`}
      >
        <span className="truncate">{event.title}</span>
        {compact && event.is_unpublished && (
          <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-normal">
            Draft
          </span>
        )}
      </div>

      {/* Compact: when and where, on one line. They were two lines, and a class
          of 65 minutes has room for one — so the second was sliced in half at
          the bottom edge of the block. The whole line is one truncating span,
          with the full text on hover for whatever the column was too narrow to
          show. */}
      {compact && showMeta && (
        <div className="flex items-center gap-1.5 text-xs text-ink-2 min-w-0">
          <ClockCircleOutlined aria-hidden className="text-gray-400 shrink-0" />
          <span className="truncate" title={metaText}>
            {formatTimeRange(event.start_time, event.end_time)}
            {place && (
              <>
                {' · '}
                <span
                  className={event.meeting_link ? 'text-blue-600 dark:text-blue-400' : undefined}
                >
                  {place}
                </span>
              </>
            )}
          </span>
        </div>
      )}

      {/* Full: a row each, and how long the event runs. Unchanged — the modal
          has the room the block does not. */}
      {!compact && (
        <div className="flex items-center gap-1.5 text-xs text-ink-2">
          <ClockCircleOutlined aria-hidden className="text-gray-400" />
          <span className="truncate">
            {formatTime(event.start_time)} - {formatTime(event.end_time)}
          </span>
          <span className="text-ink-4">• {formatDuration(duration)}</span>
        </div>
      )}

      {/* Additional details (non-compact only) */}
      {!compact && (
        <>
          {/* Location */}
          {event.location && (
            <div className="flex items-center gap-1.5 text-xs text-ink-2">
              <EnvironmentOutlined aria-hidden className="text-gray-400" />
              <span className="truncate">{event.location}</span>
            </div>
          )}

          {/* Meeting Link */}
          {event.meeting_link && (
            <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
              <VideoCameraOutlined aria-hidden />
              <span>Virtual meeting</span>
            </div>
          )}

          {/* Event Type + Tags Row */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${getEventTypeLightBg(
                event.event_type
              )} ${getEventTypeDarkText(event.event_type)}`}
            >
              {getEventTypeLabel(event.event_type)}
            </span>

            {event.is_unpublished && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                Draft
              </span>
            )}

            {event.is_recurring && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-neutral-700 text-ink-2">
                Recurring
              </span>
            )}

            {event.is_overridden && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
                Modified
              </span>
            )}

            {isHappeningNow && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 animate-pulse">
                Now
              </span>
            )}
          </div>

          {/* Creator */}
          {showCreator && event.creator && (
            <div className="text-xs text-gray-500 dark:text-gray-500 pt-1 border-t border-gray-100 dark:border-neutral-700">
              Created by {event.creator.name || event.creator.login}
            </div>
          )}

          {/* Deadline description */}
          {event.is_deadline && event.description && (
            <div className="text-xs text-ink-2 italic pt-1">{event.description}</div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      className={`
        group transition-all
        ${getEventTypeLightBg(event.event_type)}
        border ${getEventTypeBorderColor(event.event_type)} border-l-4
        rounded-r-md shadow-sm hover:shadow-md overflow-hidden
        ${isHappeningNow ? 'ring-2 ring-blue-500/50 ring-offset-1' : ''}
        ${fill}
      `}
    >
      {onClick ? (
        <button
          type="button"
          onClick={() => onClick(event)}
          // The ring is drawn INSIDE the button: it fills a card that clips its
          // overflow, so an outset ring — or an outline at a positive
          // offset — is painted straight into the clip and never seen.
          className={`block w-full text-left cursor-pointer ${padding} ${fillChild} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}
        >
          {body}
        </button>
      ) : (
        <div className={`${padding} ${fillChild}`}>{body}</div>
      )}
    </div>
  );
};

export default EventCard;
