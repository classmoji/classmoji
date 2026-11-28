/**
 * The `data` of a calendar event's audit row, one shape for both web calendars
 * (the owner/teacher calendar, `admin.$class.calendar`, re-exported under
 * /teacher, and the assistant calendar), so the same write is recorded the
 * same way whichever page made it. Each route writes the row itself, through
 * `addClassroomAuditLog`, once its write has landed, with the role its gate
 * resolved. Ids, codes and the event's title only (descriptions can be long).
 */

import type { AuditMetadata } from '~/utils/helpers';

/** What `calendar.updateEventLinks` reports it saved, as the rows record it. */
interface SavedLinks {
  linked?: unknown;
}

/** CALENDAR / CREATE on the new event. */
export const calendarCreateAudit = (
  createData: { title?: unknown; event_type?: unknown; recurrence_rule?: unknown },
  saved: SavedLinks | null
): AuditMetadata => ({
  tool: 'web:calendar.create_event',
  title: createData.title ?? null,
  event_type: createData.event_type ?? null,
  is_recurring: Boolean(createData.recurrence_rule),
  // What the service saved, not what was asked for: ids it could not
  // validate are dropped there without an error.
  linked: saved?.linked ?? null,
});

/** CALENDAR / UPDATE on the event that was edited. */
export const calendarUpdateAudit = (
  updateData: Record<string, unknown>,
  {
    editScope,
    occurrenceDate,
    linksUpdated,
  }: { editScope?: unknown; occurrenceDate?: unknown; linksUpdated: boolean },
  saved: SavedLinks | null
): AuditMetadata => ({
  tool: 'web:calendar.update_event',
  // Which fields moved, not their contents — descriptions can be long.
  fields: Object.keys(updateData),
  // A recurring edit changes a different number of occurrences depending on
  // scope, so the scope is part of what was done.
  edit_scope: editScope ?? null,
  occurrence_date: occurrenceDate ?? null,
  links_updated: linksUpdated,
  // What the link write saved for that date, as on a create.
  linked: saved?.linked ?? null,
});

/** CALENDAR / DELETE on the event that went. */
export const calendarDeleteAudit = (
  event: { title: string },
  options: { editScope?: unknown; occurrenceDate?: unknown } | null
): AuditMetadata => ({
  tool: 'web:calendar.delete_event',
  title: event.title,
  // Scope decides whether one occurrence or the whole series went away.
  delete_scope: options?.editScope ?? null,
  occurrence_date: options?.occurrenceDate ?? null,
});
