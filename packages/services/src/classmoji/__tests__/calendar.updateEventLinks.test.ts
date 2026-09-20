/**
 * `updateEventLinks` checks its TARGET, not just the resources being linked.
 *
 * The resource ids have always been validated against the classroom, which
 * stops a caller attaching another class's page. The event id was taken on
 * trust — and the write it drives is a delete-then-insert for that event and
 * date, so an id from another classroom would have cleared that event's links
 * and put this classroom's in their place.
 *
 * Every caller reaches this after its own gate, so the check is a backstop
 * rather than the only wall; it is also the one place that holds for callers
 * added later.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEvent = { findFirst: vi.fn() };
const page = { findMany: vi.fn() };
const slide = { findMany: vi.fn() };
const assignment = { findMany: vi.fn() };
const calendarEventPageLink = { deleteMany: vi.fn(), createMany: vi.fn() };
const calendarEventSlideLink = { deleteMany: vi.fn(), createMany: vi.fn() };
const calendarEventAssignmentLink = { deleteMany: vi.fn(), createMany: vi.fn() };

const client = {
  calendarEvent,
  page,
  slide,
  assignment,
  calendarEventPageLink,
  calendarEventSlideLink,
  calendarEventAssignmentLink,
  $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(client)),
};

vi.mock('@classmoji/database', () => ({ default: () => client }));

const { updateEventLinks } = await import('../calendar.service.ts');

beforeEach(() => {
  vi.clearAllMocks();
  calendarEvent.findFirst.mockResolvedValue({ id: 'event-1' });
  page.findMany.mockResolvedValue([{ id: 'p-1' }]);
  slide.findMany.mockResolvedValue([]);
  assignment.findMany.mockResolvedValue([]);
});

describe('updateEventLinks — the event has to be in this classroom', () => {
  it('asks whether it is, before writing anything', async () => {
    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(calendarEvent.findFirst).toHaveBeenCalledWith({
      where: { id: 'event-1', classroom_id: 'class-1' },
      select: { id: true },
    });
    expect(calendarEventPageLink.createMany).toHaveBeenCalled();
  });

  it('refuses, and writes nothing, when it is not', async () => {
    calendarEvent.findFirst.mockResolvedValue(null);

    await expect(
      updateEventLinks('event-from-another-class', 'class-1', { pageIds: ['p-1'] })
    ).rejects.toThrow('Calendar event not found in this classroom');

    // The refusal has to land before the delete half of the write, or it would
    // clear the other event's links on its way out.
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(calendarEventPageLink.deleteMany).not.toHaveBeenCalled();
    expect(calendarEventPageLink.createMany).not.toHaveBeenCalled();
  });

  it('refuses an empty link set just the same', async () => {
    // "Clear this event's links for this date" is still a write.
    calendarEvent.findFirst.mockResolvedValue(null);

    await expect(updateEventLinks('event-x', 'class-1', {})).rejects.toThrow(
      'Calendar event not found in this classroom'
    );
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});
