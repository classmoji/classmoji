/**
 * What a scoped edit or delete does to a recurring event's per-date resource
 * links.
 *
 * Links are stored against one occurrence date, so a scope that changes WHICH
 * event owns a date has to take that date's links with it:
 *   - 'this and future' ends the old event and starts a new one from this date
 *     on. Every link dated on or after the split belongs to the new event; the
 *     dates before it, and the undated bucket, stay behind.
 *   - deleting 'this and future' removes those occurrences, so their links go
 *     too rather than outliving the dates they hang on.
 *   - 'this only' and 'all' leave the link tables alone: they change an
 *     occurrence's times or the series template, not who owns which date.
 *
 * Prisma is mocked, and `$transaction` hands the same mock back as `tx`, so the
 * assertions below are about the calls the service makes — including that it
 * makes them inside one transaction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEvent = {
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};
const calendarEventOverride = {
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
const linkTable = () => ({ updateMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() });
const calendarEventPageLink = linkTable();
const calendarEventSlideLink = linkTable();
const calendarEventAssignmentLink = linkTable();

const client = {
  calendarEvent,
  calendarEventOverride,
  calendarEventPageLink,
  calendarEventSlideLink,
  calendarEventAssignmentLink,
  // Interactive transaction: the callback runs against the same mocks.
  $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(client)),
};

vi.mock('@classmoji/database', () => ({ default: () => client }));

const { updateEventWithScope, deleteEventWithScope } = await import('../calendar.service.ts');

/** The occurrence being edited, with a time on it — as a route passes it. */
const OCCURRENCE = new Date('2026-09-28T13:00:00Z');
/** Link rows are date-only, so the boundary is this date at midnight UTC. */
const SPLIT_BOUNDARY = new Date('2026-09-28T00:00:00.000Z');

const STORED_EVENT = {
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  event_type: 'LECTURE',
  title: 'Lecture',
  description: null,
  start_time: new Date('2026-09-07T14:00:00Z'),
  end_time: new Date('2026-09-07T15:00:00Z'),
  location: null,
  meeting_link: null,
  is_recurring: true,
  recurrence_rule: { days: ['monday'] },
  overrides: [],
};

const linkTables = () => [
  calendarEventPageLink,
  calendarEventSlideLink,
  calendarEventAssignmentLink,
];

beforeEach(() => {
  vi.clearAllMocks();
  calendarEvent.findUnique.mockResolvedValue(STORED_EVENT);
  calendarEvent.create.mockResolvedValue({ ...STORED_EVENT, id: 'event-2' });
  calendarEvent.update.mockResolvedValue({ ...STORED_EVENT });
});

describe('updateEventWithScope — this and future', () => {
  it('hands the occurrences from this date on to the new event, links included', async () => {
    const result = await updateEventWithScope('event-1', {}, 'this_and_future', OCCURRENCE);

    expect(result).toMatchObject({ id: 'event-2' });

    for (const table of linkTables()) {
      expect(table.updateMany).toHaveBeenCalledWith({
        where: { event_id: 'event-1', occurrence_date: { gte: SPLIT_BOUNDARY } },
        data: { event_id: 'event-2' },
      });
    }
  });

  it('does the split in one transaction', async () => {
    // Half a split is worse than none: an ended series whose later links still
    // point at it shows the resources on no date at all.
    await updateEventWithScope('event-1', {}, 'this_and_future', OCCURRENCE);

    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves the earlier dates, and the undated bucket, with the original event', async () => {
    await updateEventWithScope('event-1', {}, 'this_and_future', OCCURRENCE);

    // `gte` selects the split date onwards and never matches NULL, so the rows
    // that stay behind are decided by this one filter — assert it exactly.
    const [{ where }] = calendarEventPageLink.updateMany.mock.calls[0];
    expect(where).toEqual({
      event_id: 'event-1',
      occurrence_date: { gte: SPLIT_BOUNDARY },
    });
  });
});

describe('updateEventWithScope — the scopes that own no dates', () => {
  it('touches no link row for an edit to this occurrence only', async () => {
    await updateEventWithScope(
      'event-1',
      { start_time: '2026-09-28T15:00:00Z', end_time: '2026-09-28T16:00:00Z' },
      'this_only',
      OCCURRENCE
    );

    expect(calendarEventOverride.create).toHaveBeenCalled();
    for (const table of linkTables()) {
      expect(table.updateMany).not.toHaveBeenCalled();
      expect(table.deleteMany).not.toHaveBeenCalled();
    }
  });

  it('touches no link row for an edit to the whole series', async () => {
    await updateEventWithScope('event-1', { title: 'Renamed' }, 'all', OCCURRENCE);

    for (const table of linkTables()) {
      expect(table.updateMany).not.toHaveBeenCalled();
      expect(table.deleteMany).not.toHaveBeenCalled();
    }
  });
});

describe('deleteEventWithScope — this and future', () => {
  it('removes the links on the dates it removes', async () => {
    await deleteEventWithScope('event-1', 'this_and_future', OCCURRENCE);

    for (const table of linkTables()) {
      expect(table.deleteMany).toHaveBeenCalledWith({
        where: { event_id: 'event-1', occurrence_date: { gte: SPLIT_BOUNDARY } },
      });
    }
    expect(calendarEventOverride.deleteMany).toHaveBeenCalled();
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves the link rows alone when only this occurrence is cancelled', async () => {
    await deleteEventWithScope('event-1', 'this_only', OCCURRENCE);

    for (const table of linkTables()) {
      expect(table.deleteMany).not.toHaveBeenCalled();
    }
  });
});
