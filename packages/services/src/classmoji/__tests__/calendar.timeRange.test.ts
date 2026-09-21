/**
 * An event has to end after it starts, and the service is where that is
 * decided — every surface that writes one goes through these three entry
 * points.
 *
 * Only a range with BOTH edges is checked. A single moved edge cannot be
 * compared against the stored row: for a recurring series those stored times
 * are the TEMPLATE's absolute datetimes, dated at the series start, not the
 * occurrence being edited. calendar_event_update in apps/mcp draws the same
 * line, for the same reason, and both forms always send both edges.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEvent = {
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
};
const calendarEventOverride = { create: vi.fn(), update: vi.fn() };

vi.mock('@classmoji/database', () => ({
  default: () => ({ calendarEvent, calendarEventOverride }),
}));

const { createEvent, updateEvent, updateEventWithScope, CalendarTimeRangeError } = await import(
  '../calendar.service.ts'
);

const OCCURRENCE = new Date('2026-09-28T13:00:00Z');
/** 11 PM to midnight, stamped onto one date — a negative duration. */
const BACKWARDS = { start_time: '2026-09-21T23:00:00Z', end_time: '2026-09-21T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  calendarEvent.findUnique.mockResolvedValue({
    id: 'event-1',
    is_recurring: true,
    recurrence_rule: { days: ['monday'] },
    overrides: [],
  });
  calendarEvent.update.mockResolvedValue({ id: 'event-1' });
});

describe('an event must end after it starts', () => {
  it('refuses to create one that does not', async () => {
    await expect(
      createEvent('class-1', 'owner-1', {
        event_type: 'LECTURE',
        title: 'Backwards',
        ...BACKWARDS,
      })
    ).rejects.toBeInstanceOf(CalendarTimeRangeError);

    expect(calendarEvent.create).not.toHaveBeenCalled();
  });

  it('refuses to update one into that state', async () => {
    await expect(updateEvent('event-1', BACKWARDS)).rejects.toBeInstanceOf(CalendarTimeRangeError);

    expect(calendarEvent.update).not.toHaveBeenCalled();
  });

  it('refuses a scoped edit into that state, before reading the event', async () => {
    await expect(
      updateEventWithScope('event-1', BACKWARDS, 'this_only', OCCURRENCE)
    ).rejects.toBeInstanceOf(CalendarTimeRangeError);

    expect(calendarEvent.findUnique).not.toHaveBeenCalled();
    expect(calendarEventOverride.create).not.toHaveBeenCalled();
  });

  it('refuses a zero-length event', async () => {
    const sameInstant = '2026-09-21T09:00:00Z';

    await expect(
      createEvent('class-1', 'owner-1', {
        event_type: 'LECTURE',
        title: 'Instant',
        start_time: sameInstant,
        end_time: sameInstant,
      })
    ).rejects.toBeInstanceOf(CalendarTimeRangeError);
  });

  it('says what is wrong, in words a user can act on', async () => {
    const error = await updateEvent('event-1', BACKWARDS).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(error?.message).toBe('End time must be after the start time');
  });

  it('leaves a partial update alone — one moved edge is not a range', async () => {
    await updateEvent('event-1', { end_time: '2026-09-21T00:00:00Z' });

    expect(calendarEvent.update).toHaveBeenCalled();
  });
});
