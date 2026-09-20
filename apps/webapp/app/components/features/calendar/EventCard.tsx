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
import { blockLayout } from './geometry';
import ResourceLink, { RESOURCE_ICONS } from './ResourceLink';
import type { CalendarResource, ResourceKind, ResourceLinkContext } from './ResourceLink';
import type { CalendarEventWithLinks } from './types';

/** Types whose block says where it is. A deadline has no room. */
const TYPES_WITH_A_ROOM = ['OFFICE_HOURS', 'LECTURE', 'LAB'];

/** The order a cluster names the kinds in, so two blocks never disagree. */
const KIND_ORDER: ResourceKind[] = ['page', 'slide', 'assignment'];

interface EventCardProps {
  event: CalendarEventWithLinks;
  onClick?: (event: CalendarEventWithLinks) => void;
  showCreator?: boolean;
  compact?: boolean;
  /**
   * Compact only: how many hours tall the slot is that this card has to fit
   * into. It decides two things — whether there is room under the title for the
   * meta row, and whether the card has to buy that room out of its vertical
   * padding — and `geometry` answers both from the duration, never from a
   * measured height.
   *
   * Left out, the card has no slot to fit: the modal and the drag overlay size
   * themselves, so they draw everything at the roomier padding — and neither
   * of them draws resource chips.
   */
  blockHours?: number;
  /**
   * Everything this event links to, for the viewer being answered. The grid
   * flattens them (`resourcesForEvent`); the card only decides how many of
   * them its slot can show.
   */
  resources?: CalendarResource[];
  /** Where those links point — threaded from the route through the grid. */
  linkContext?: ResourceLinkContext;
}

/**
 * One event, as a block in the week grid (`compact`) or as the body of the
 * detail modal.
 *
 * The card is a NON-interactive container holding the event's own `<button>`
 * and, beside it, a link to each thing the event is linked to. It used to be a
 * `<div onClick>`, which no keyboard could reach and no screen reader
 * announced; and it has to stay a container rather than become a button
 * itself, because an anchor inside a button is not renderable. With no
 * `onClick` — the modal, the drag overlay — there is nothing to press, so no
 * button is rendered at all.
 *
 * How many of those links are drawn is `blockLayout`'s answer, and it comes
 * from the event's DURATION: two hours of block lists several, an hour lists
 * one and says `+N`, and anything shorter shows an icon per kind on the title
 * row. Never from a measured height — an hour row is 56–80px depending on the
 * reader's font size, and everything in the calculation scales with it.
 */
const EventCard = ({
  event,
  onClick,
  showCreator = false,
  compact = false,
  blockHours,
  resources = [],
  linkContext,
}: EventCardProps) => {
  const isHappeningNow = isEventNow(event);
  const duration = getEventDuration(event);

  /**
   * Every answer about what fits comes from the one number, so the rows, the
   * chips and the padding that makes room for them can never disagree about
   * how tall the block is.
   */
  const layout = blockHours === undefined ? null : blockLayout(blockHours, resources.length);
  const showMeta = layout === null || layout.showMeta;
  const tight = layout !== null && layout.tight;
  const padding = compact ? (tight ? 'px-2 py-1' : 'p-2') : 'p-3';

  // Chips are a week-block thing: the modal lists everything in full, and the
  // drag overlay has no slot to measure.
  const chipCount = compact && layout ? Math.min(layout.chipLines, resources.length) : 0;
  const visibleChips = resources.slice(0, chipCount);
  const hiddenChips = resources.length - visibleChips.length;

  /**
   * Too short for a chip line, but not too narrow for a mark: one icon per
   * kind on the title row, with a count when there is more than one. It costs
   * no height at all, which is the only budget a 45-minute block has left.
   *
   * Bounded by construction — there are three kinds — and `shrink-0`, so it
   * fits beside the title at any column width and the title truncates first.
   */
  const cluster =
    compact && layout !== null && layout.chipLines === 0
      ? KIND_ORDER.map(kind => ({
          kind,
          count: resources.filter(resource => resource.kind === kind).length,
        })).filter(group => group.count > 0)
      : [];

  /**
   * What the block's own button says about its links. The chips beside it are
   * separate controls, and `+N` and the cluster are decorative — so this is
   * the only place a screen reader hears that a short block has anything
   * attached to it at all.
   */
  const resourceSummary =
    compact && resources.length > 0
      ? `${resources.length} linked ${resources.length === 1 ? 'resource' : 'resources'}`
      : '';

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
   * The block button's name, written out rather than assembled from whatever
   * text happens to be on screen.
   *
   * It has to say the same things in the same order whether or not the meta
   * row was drawn — a 60-minute block trades that row for a chip line, and the
   * time must not leave with it — and the pieces have to be separated by
   * commas, which is not something a reader can hear in a flex row. The
   * visible content is also no longer INSIDE the button (it sits over it, so a
   * click anywhere on the block opens the event), so there is nothing for a
   * browser to compute a name from.
   *
   * Order: what it is, when and where, whether the class can see it, what is
   * attached to it.
   */
  const accessibleName = [
    event.title,
    compact ? metaText : null,
    compact && event.is_unpublished ? 'Draft' : null,
    resourceSummary || null,
  ]
    .filter(Boolean)
    .join(', ');

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
  // `relative` on the card is what makes it the containing block for the
  // full-bleed hit-area button underneath the visible column.
  const fill = compact ? 'relative h-full flex flex-col min-h-0' : 'relative';
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
        {/* The column is narrow enough that most titles truncate, so the whole
            one stays readable on hover. */}
        <span className="truncate" title={compact ? event.title : undefined}>
          {event.title}
        </span>
        {compact && event.is_unpublished && (
          <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-normal">
            Draft
          </span>
        )}
        {cluster.length > 0 && (
          // Decorative: the count is in the button's accessible name, and
          // reading three icon names in the middle of the event's title is
          // worse than not drawing them.
          <span className="ml-auto flex shrink-0 items-center gap-1 text-ink-3" aria-hidden="true">
            {cluster.map(({ kind, count }) => {
              const Icon = RESOURCE_ICONS[kind];
              return (
                <span key={kind} className="flex items-center gap-px">
                  <Icon size={11} />
                  {count > 1 && <span className="text-[0.625rem] leading-none">{count}</span>}
                </span>
              );
            })}
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
      {/* The hit area: the WHOLE block, underneath everything it draws.
          It carries no content — the visible column sits over it — so its
          name is written out rather than read off the screen.

          The focus ring is drawn INSIDE: the button fills a card that clips
          its overflow, so an outset ring — or an outline at a positive
          offset — is painted straight into the clip and never seen. */}
      {onClick && (
        <button
          type="button"
          onClick={() => onClick(event)}
          aria-label={accessibleName}
          className="absolute inset-0 w-full cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        />
      )}

      {/* The visible column, starting at the TOP: a two-hour block used to
          draw its title down the middle of the slot.

          `pointer-events-none` is what lets the button underneath take a click
          anywhere the reader has not aimed at a chip — before this, the chip
          container swallowed a third of a 65-minute block and nearly half of a
          two-hour one, where the block dragged but would not open. */}
      <div
        className={`relative flex flex-col justify-start items-stretch ${fillChild} ${
          onClick ? 'pointer-events-none' : ''
        }`}
      >
        <div className={`${padding} min-h-0`}>{body}</div>

        {/* The links, as SIBLINGS of the event's button — an anchor inside a
            button is not renderable, and out here the staff drag layer sees a
            chip press as a press on the chip.

            Directly under the meta row, not pinned to the bottom of the block.
            The negative top margin reclaims the padding the rows above end
            with, which is why the budget in `blockLayout` charges the first
            chip line for its box and no gap — and it has to track the padding,
            or the chips ride up over the meta row. */}
        {visibleChips.length > 0 && (
          <div
            className={`shrink-0 flex flex-col gap-0.5 min-w-0 overflow-hidden px-2 ${
              tight ? '-mt-1 pb-1' : '-mt-2 pb-2'
            }`}
          >
            {visibleChips.map((resource, index) => (
              <div
                key={`${resource.kind}-${resource.id}`}
                className="flex items-center gap-1 min-w-0"
              >
                <ResourceLink
                  resource={resource}
                  context={linkContext}
                  variant="chip"
                  // The star says the same thing the month cell says, so an
                  // instructor can see at a glance what their class will see.
                  showStar
                />
                {hiddenChips > 0 && index === visibleChips.length - 1 && (
                  // NOT a control: what it stands for is "open the event and
                  // see the rest", which is what the block's own button does —
                  // and it takes no pointer events, so a click on it falls
                  // through to that button. Hidden from assistive technology
                  // because the count is already in the button's name.
                  <span
                    aria-hidden="true"
                    title={resources
                      .slice(visibleChips.length)
                      .map(resource => resource.title)
                      .join(', ')}
                    className="shrink-0 rounded px-1 text-[0.6875rem] leading-none text-ink-3"
                  >
                    +{hiddenChips}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default EventCard;
