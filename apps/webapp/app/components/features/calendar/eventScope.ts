/**
 * The two rules an edit to a recurring event turns on, kept out of the modal so
 * they can be read — and tested — on their own.
 *
 * Both follow from the same fact: a resource link is stored against ONE
 * occurrence date. So there is a link picker to prefill only for the occurrence
 * being edited, and a date to save links against only when the edit is scoped
 * to that occurrence.
 */

export const EDIT_SCOPES = {
  THIS_ONLY: 'this_only',
  THIS_AND_FUTURE: 'this_and_future',
  ALL: 'all',
} as const;

export type CalendarEditScope = (typeof EDIT_SCOPES)[keyof typeof EDIT_SCOPES];

/** The link ids the three pickers hold. */
export interface EventLinkIds {
  linkedPageIds: string[];
  linkedSlideIds: string[];
  linkedAssignmentIds: string[];
}

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
 *   - RECURRING: the links dated to this occurrence, and nothing else. An
 *     undated link predates the event becoming recurring and the service
 *     ignores it; showing it here would offer the user a link the calendar does
 *     not display, and re-save it onto this date.
 *   - NOT recurring: the undated links (the event's own), plus any dated link
 *     that happens to fall on its date.
 */
export const filterLinksForOccurrence = <T extends { occurrence_date?: string | Date | null }>(
  links: T[] | undefined,
  occurrenceDate: string | Date,
  isRecurring: boolean
): T[] => {
  if (!links) return [];
  return links.filter(link =>
    link.occurrence_date ? isSameDateDay(link.occurrence_date, occurrenceDate) : !isRecurring
  );
};

/**
 * Whether an edit at this scope has an occurrence to save links against.
 *
 * Only 'this_only' does. 'all' and 'this and future' address the series, and a
 * link saved from one of those lands in the undated bucket, which a recurring
 * event's occurrences do not read — the links would simply disappear.
 */
export const scopeCarriesLinks = (editScope: string): boolean =>
  editScope === EDIT_SCOPES.THIS_ONLY;

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
