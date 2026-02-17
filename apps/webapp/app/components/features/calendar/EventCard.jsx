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

const EventCard = ({ event, onClick, showCreator = false, compact = false }) => {
  const isHappeningNow = isEventNow(event);
  const duration = getEventDuration(event);

  return (
    <div
      className={`
        group transition-all
        ${getEventTypeLightBg(event.event_type)}
        border ${getEventTypeBorderColor(event.event_type)} border-l-4
        rounded-r-md shadow-sm hover:shadow-md
        ${compact ? 'p-2' : 'p-3'}
        ${isHappeningNow ? 'ring-2 ring-blue-500/50 ring-offset-1' : ''}
        cursor-pointer
      `}
      onClick={() => onClick?.(event)}
    >
      <div className="space-y-1.5">
        {/* Title */}
        <div className={`font-medium ${getEventTypeDarkText(event.event_type)} ${compact ? 'text-sm' : 'text-base'} line-clamp-1 flex items-center gap-2`}>
          <span>{event.title}</span>
          {compact && event.is_unpublished && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-normal">
              Draft
            </span>
          )}
        </div>

        {/* Time */}
        <div className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <ClockCircleOutlined className="text-gray-400" />
          <span>
            {formatTime(event.start_time)} - {formatTime(event.end_time)}
          </span>
          {!compact && (
            <span className="text-gray-400 dark:text-gray-500">• {formatDuration(duration)}</span>
          )}
        </div>

        {/* Location/Virtual for compact view (office hours and lectures) */}
        {compact && ['OFFICE_HOURS', 'LECTURE', 'LAB'].includes(event.event_type) && (
          <div className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            {event.meeting_link ? (
              <>
                <VideoCameraOutlined className="text-blue-500" />
                <span className="text-blue-600 dark:text-blue-400">Virtual</span>
              </>
            ) : event.location ? (
              <>
                <EnvironmentOutlined className="text-gray-400" />
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
              <div className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                <EnvironmentOutlined className="text-gray-400" />
                <span className="truncate">{event.location}</span>
              </div>
            )}

            {/* Meeting Link */}
            {event.meeting_link && (
              <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                <VideoCameraOutlined />
                <span>Virtual meeting</span>
              </div>
            )}

            {/* Event Type + Tags Row */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              <span className={`text-xs px-2 py-0.5 rounded-full ${getEventTypeLightBg(event.event_type)} ${getEventTypeDarkText(event.event_type)}`}>
                {getEventTypeLabel(event.event_type)}
              </span>

              {event.is_unpublished && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                  Draft
                </span>
              )}

              {event.is_recurring && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
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
              <div className="text-xs text-gray-500 dark:text-gray-500 pt-1 border-t border-gray-100 dark:border-gray-700">
                Created by {event.creator.name || event.creator.login}
              </div>
            )}

            {/* Deadline description */}
            {event.is_deadline && event.description && (
              <div className="text-xs text-gray-600 dark:text-gray-400 italic pt-1">
                {event.description}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default EventCard;
