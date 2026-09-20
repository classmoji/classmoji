import type { ReactNode } from 'react';
import { ClockCircleOutlined, EnvironmentOutlined, VideoCameraOutlined } from '@ant-design/icons';
import {
  formatTime,
  getEventTypeBorderColor,
  getEventTypeLabel,
  getEventDuration,
  formatDuration,
  isEventNow,
  getEventTypeLightBg,
  getEventTypeDarkText,
} from './utils';
import type { CalendarEventWithLinks } from './types';

interface EventCardProps {
  event: CalendarEventWithLinks;
  onClick?: (event: CalendarEventWithLinks) => void;
  showCreator?: boolean;
  compact?: boolean;
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
const EventCard = ({ event, onClick, showCreator = false, compact = false }: EventCardProps) => {
  const isHappeningNow = isEventNow(event);
  const duration = getEventDuration(event);
  const padding = compact ? 'p-2' : 'p-3';

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
    <div className={`space-y-1.5 ${compact ? 'min-h-0' : ''}`}>
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

      {/* Time */}
      <div className="flex items-center gap-1.5 text-xs text-ink-2">
        <ClockCircleOutlined aria-hidden className="text-gray-400" />
        <span className="truncate">
          {formatTime(event.start_time)} - {formatTime(event.end_time)}
        </span>
        {!compact && <span className="text-ink-4">• {formatDuration(duration)}</span>}
      </div>

      {/* Location/Virtual for compact view (office hours, lectures and labs) */}
      {compact && ['OFFICE_HOURS', 'LECTURE', 'LAB'].includes(event.event_type) && (
        <div className="flex items-center gap-1.5 text-xs text-ink-2">
          {event.meeting_link ? (
            <>
              <VideoCameraOutlined aria-hidden className="text-blue-500" />
              <span className="text-blue-600 dark:text-blue-400">Virtual</span>
            </>
          ) : event.location ? (
            <>
              <EnvironmentOutlined aria-hidden className="text-gray-400" />
              <span className="truncate">{event.location}</span>
            </>
          ) : null}
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
