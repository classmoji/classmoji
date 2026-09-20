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

/** The parent-event row lock the transaction takes before it writes anything. */
const $queryRaw = vi.fn();

const client = {
  calendarEvent,
  page,
  slide,
  assignment,
  calendarEventPageLink,
  calendarEventSlideLink,
  calendarEventAssignmentLink,
  $queryRaw,
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

describe('updateEventLinks — the star', () => {
  /** What each kind's createMany was asked to write, id → featured. */
  const written = (createMany: { mock: { calls: unknown[][] } }, key: string) => {
    const call = createMany.mock.calls[0]?.[0] as
      | { data: Array<Record<string, unknown>> }
      | undefined;
    if (!call) return {};
    return Object.fromEntries(call.data.map(row => [row[key], row.featured]));
  };

  beforeEach(() => {
    page.findMany.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
    slide.findMany.mockResolvedValue([{ id: 's-1' }]);
    assignment.findMany.mockResolvedValue([{ id: 'a-1' }]);
  });

  const allIds = { pageIds: ['p-1', 'p-2'], slideIds: ['s-1'], assignmentIds: ['a-1'] };

  it('locks the parent event row before it deletes anything', async () => {
    // Read Committed does not stop two concurrent saves each inserting a star
    // into a different table; the lock is what makes them queue. It is worth
    // nothing if it is taken after the delete half of the write.
    await updateEventLinks('event-1', 'class-1', allIds, null, { kind: 'page', id: 'p-1' });

    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      calendarEventPageLink.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it.each([
    ['page', { kind: 'page' as const, id: 'p-2' }, { 'p-1': false, 'p-2': true }, false, false],
    ['slide', { kind: 'slide' as const, id: 's-1' }, { 'p-1': false, 'p-2': false }, true, false],
    [
      'assignment',
      { kind: 'assignment' as const, id: 'a-1' },
      { 'p-1': false, 'p-2': false },
      false,
      true,
    ],
  ])('sets it on exactly the named %s row', async (_kind, featured, pages, deck, hw) => {
    await updateEventLinks('event-1', 'class-1', allIds, null, featured);

    expect(written(calendarEventPageLink.createMany, 'page_id')).toEqual(pages);
    expect(written(calendarEventSlideLink.createMany, 'slide_id')).toEqual({ 's-1': deck });
    expect(written(calendarEventAssignmentLink.createMany, 'assignment_id')).toEqual({ 'a-1': hw });
  });

  it('writes no star when the caller names none', async () => {
    await updateEventLinks('event-1', 'class-1', allIds);

    expect(written(calendarEventPageLink.createMany, 'page_id')).toEqual({
      'p-1': false,
      'p-2': false,
    });
    expect(written(calendarEventSlideLink.createMany, 'slide_id')).toEqual({ 's-1': false });
  });

  it('drops a star naming something this save is not linking, and still saves the links', async () => {
    await updateEventLinks('event-1', 'class-1', allIds, null, {
      kind: 'page',
      id: 'p-unlinked',
    });

    expect(written(calendarEventPageLink.createMany, 'page_id')).toEqual({
      'p-1': false,
      'p-2': false,
    });
    expect(calendarEventPageLink.createMany).toHaveBeenCalled();
  });

  it('neither links nor stars an id from another classroom', async () => {
    // The validation query is what drops it; the star is resolved against what
    // survived, so the same id cannot come back in through the star.
    page.findMany.mockResolvedValue([{ id: 'p-1' }]);

    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1', 'p-elsewhere'] }, null, {
      kind: 'page',
      id: 'p-elsewhere',
    });

    expect(written(calendarEventPageLink.createMany, 'page_id')).toEqual({ 'p-1': false });
  });

  it('writes the star against the occurrence date the links are written against', async () => {
    const occurrence = new Date('2026-09-28T00:00:00.000Z');
    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, occurrence, {
      kind: 'page',
      id: 'p-1',
    });

    const [{ data }] = calendarEventPageLink.createMany.mock.calls[0] as [
      { data: Array<Record<string, unknown>> },
    ];
    expect(data[0]).toMatchObject({ page_id: 'p-1', featured: true });
    expect((data[0].occurrence_date as Date).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    // Only this date's rows were cleared — another occurrence keeps its own star.
    expect(calendarEventPageLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: expect.any(Date) },
    });
  });
});
