/**
 * The two rules an edit to a recurring event turns on, kept out of the modal so
 * they can be read — and tested — on their own.
 *
 * Both follow from the same fact: a resource link is stored against ONE
 * occurrence date. So there is a link picker to prefill only for the occurrence
 * being edited, and a date to save links against only when the edit is scoped
 * to that occurrence.
 */

import { scopeCarriesLinks } from '@classmoji/services/calendar-policy';

/**
 * Re-exported so a modal reads one name. The RULE lives in the write-policy
 * module, which both web actions import too — a fourth hand-written copy of
 * `editScope === 'this_only'` is exactly what this replaces.
 *
 * Safe for the browser: that module is dependency-free by design, and this file
 * is reached only from the staff edit modal.
 */
export { scopeCarriesLinks };

export const EDIT_SCOPES = {
  THIS_ONLY: 'this_only',
  THIS_AND_FUTURE: 'this_and_future',
  ALL: 'all',
} as const;

export type CalendarEditScope = (typeof EDIT_SCOPES)[keyof typeof EDIT_SCOPES];

/**
 * Was this item EXPANDED as a recurring occurrence?
 *
 * The question everything below actually turns on, and it is answered by
 * `occurrence_date`, not by `is_recurring`. The calendar sets that date only on
 * rows it expanded date by date; an event flagged recurring whose rule names no
 * days has none to expand, so it is shown once, off its own date, reading its
 * undated links. Reading the flag instead would hide those links in the picker
 * and then delete them on save.
 */
export const isExpandedOccurrence = (event: { occurrence_date?: string | Date | null }): boolean =>
  Boolean(event.occurrence_date);

/**
 * The link ids the three pickers hold — and which one of them is starred.
 *
 * The star travels with the ids because it obeys the same rule: it is a column
 * on a link row, so it exists only where those rows do. A scope with no
 * occurrence to save links against has nowhere to put a star either.
 */
export interface EventLinkIds {
  linkedPageIds: string[];
  linkedSlideIds: string[];
  linkedAssignmentIds: string[];
  featuredKind?: string | null;
  featuredId?: string | null;
}

/** Same ids, same order — the order is stored, so a reshuffle is a change. */
const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Has the user touched the links or the star since the modal prefilled them?
 *
 * Asked only to decide whether to WARN. A series-wide edit silently drops link
 * and star changes — they belong to one occurrence and 'all' names none — and
 * a save that appears to succeed while quietly discarding half of what was
 * asked for is the kind of thing a user discovers weeks later.
 */
export const linkSelectionChanged = (current: EventLinkIds, original: EventLinkIds): boolean =>
  !sameIds(current.linkedPageIds, original.linkedPageIds) ||
  !sameIds(current.linkedSlideIds, original.linkedSlideIds) ||
  !sameIds(current.linkedAssignmentIds, original.linkedAssignmentIds) ||
  (current.featuredKind ?? null) !== (original.featuredKind ?? null) ||
  (current.featuredId ?? null) !== (original.featuredId ?? null);

/** Compare two values as calendar DAYS, in UTC — link dates are date-only. */
export const isSameDateDay = (date1: string | Date, date2: string | Date) => {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return (
    d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate()
  );
};

/**
 * Which stored links belong to the occurrence being edited.
 *
 * The same rule the calendar service reads by, so the pickers show exactly what
 * the event detail shows:
 *   - an EXPANDED OCCURRENCE takes the links dated to it, and nothing else. An
 *     undated link predates the event becoming recurring and the service
 *     ignores it; showing it here would offer the user a link the calendar does
 *     not display, and re-save it onto this date.
 *   - anything else takes the undated links (the event's own), plus any dated
 *     link that happens to fall on its date.
 *
 * `isOccurrence` is the item's `occurrence_date`, NOT its `is_recurring` flag.
 * The service sets that date only on rows it expanded date by date, and an
 * event flagged recurring whose rule names no days is not one of them — it is
 * shown once, off its own date, reading its undated links.
 */
export const filterLinksForOccurrence = <T extends { occurrence_date?: string | Date | null }>(
  links: T[] | undefined,
  occurrenceDate: string | Date,
  isOccurrence: boolean
): T[] => {
  if (!links) return [];
  return links.filter(link =>
    link.occurrence_date ? isSameDateDay(link.occurrence_date, occurrenceDate) : !isOccurrence
  );
};

/**
 * The payload a scoped edit submits: the form's own fields, the scope, the
 * occurrence — and the link ids only when the scope can hold them.
 */
export const buildScopedEventData = <T extends object>(
  eventData: T,
  editScope: string,
  occurrenceDate: string | null,
  links: EventLinkIds
): T & { editScope: string; occurrenceDate: string | null } => ({
  ...eventData,
  ...(scopeCarriesLinks(editScope) ? links : {}),
  editScope,
  occurrenceDate,
});
