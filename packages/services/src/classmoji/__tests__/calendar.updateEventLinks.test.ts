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
 *
 * The later blocks pin which assignments may be linked — any in the classroom,
 * found through the module, since quiz and form assignments have no repository
 * — and the quiz rule: where the classroom's quizzes are hidden the calendar
 * read drops quiz links, so a save made there neither adds one nor deletes
 * the ones it was never shown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEvent = { findFirst: vi.fn() };
const page = { findMany: vi.fn() };
const slide = { findMany: vi.fn() };
const assignment = { findMany: vi.fn() };
const calendarEventPageLink = { deleteMany: vi.fn(), createMany: vi.fn() };
const calendarEventSlideLink = { deleteMany: vi.fn(), createMany: vi.fn() };
const calendarEventAssignmentLink = {
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
  aggregate: vi.fn(),
};
const quizzesVisible = vi.fn();

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

vi.mock('../entitlement.service.ts', () => ({
  quizzesVisible: (...a: unknown[]) => quizzesVisible(...a),
}));

const { updateEventLinks } = await import('../calendar.service.ts');

beforeEach(() => {
  vi.clearAllMocks();
  calendarEvent.findFirst.mockResolvedValue({ id: 'event-1' });
  // The lock doubles as the existence check, so it answers with the row.
  $queryRaw.mockResolvedValue([{ id: 'event-1' }]);
  page.findMany.mockResolvedValue([{ id: 'p-1' }]);
  slide.findMany.mockResolvedValue([]);
  assignment.findMany.mockResolvedValue([]);
  // No quiz link stored on the date unless a test says so.
  calendarEventAssignmentLink.count.mockResolvedValue(0);
  calendarEventAssignmentLink.aggregate.mockResolvedValue({ _max: { order: null } });
  quizzesVisible.mockResolvedValue(true);
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

  it('asks again under the lock, so a delete mid-flight is a refusal not a 500', async () => {
    // The findFirst above happens before the transaction opens. An event
    // deleted in that window used to leave the inserts to fail on a foreign
    // key, which reached the user as a constraint error.
    $queryRaw.mockResolvedValue([]);

    await expect(updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] })).rejects.toThrow(
      'Calendar event not found in this classroom'
    );

    expect(calendarEventPageLink.deleteMany).not.toHaveBeenCalled();
    expect(calendarEventPageLink.createMany).not.toHaveBeenCalled();
  });

  it('locks the row with the classroom condition, not by id alone', async () => {
    // Locking by id alone would take the lock on another classroom's event
    // before noticing it was not ours.
    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    const [strings, ...values] = $queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('FOR UPDATE');
    expect(strings.join('?')).toContain('classroom_id');
    expect(values).toEqual(['event-1', 'class-1']);
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

/** The assignment link rows the write created, id → featured. */
const assignmentRows = () => {
  const call = calendarEventAssignmentLink.createMany.mock.calls[0]?.[0] as
    | { data: Array<{ assignment_id: string; featured: boolean }> }
    | undefined;
  return Object.fromEntries((call?.data ?? []).map(row => [row.assignment_id, row.featured]));
};

describe('updateEventLinks — which assignments may be linked', () => {
  it('finds them through the module, since quiz and form assignments have no repository', async () => {
    await updateEventLinks('event-1', 'class-1', { assignmentIds: ['a-quiz', 'a-form'] });

    expect(assignment.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a-quiz', 'a-form'] }, module: { classroom_id: 'class-1' } },
      select: { id: true, type: true },
    });
  });

  it('links quiz, form and repo assignments alike, and stars any of them', async () => {
    assignment.findMany.mockResolvedValue([
      { id: 'a-quiz', type: 'QUIZ' },
      { id: 'a-form', type: 'FORM' },
      { id: 'a-repo', type: 'REPO' },
    ]);

    const result = await updateEventLinks(
      'event-1',
      'class-1',
      { assignmentIds: ['a-quiz', 'a-form', 'a-repo'] },
      null,
      { kind: 'assignment', id: 'a-form' }
    );

    expect(assignmentRows()).toEqual({ 'a-quiz': false, 'a-form': true, 'a-repo': false });
    expect(result.linked).toEqual({ pages: 0, slides: 0, assignments: 3 });
  });

  it('drops an assignment from another classroom, and the star naming it', async () => {
    // The module condition is what drops it: the query does not return it.
    assignment.findMany.mockResolvedValue([{ id: 'a-form', type: 'FORM' }]);

    const result = await updateEventLinks(
      'event-1',
      'class-1',
      { assignmentIds: ['a-form', 'a-elsewhere'] },
      null,
      { kind: 'assignment', id: 'a-elsewhere' }
    );

    expect(assignmentRows()).toEqual({ 'a-form': false });
    expect(result.linked.assignments).toBe(1);
  });

  it('reports what it saved, not what it was asked for', async () => {
    page.findMany.mockResolvedValue([{ id: 'p-1' }]);
    slide.findMany.mockResolvedValue([]);

    const result = await updateEventLinks('event-1', 'class-1', {
      pageIds: ['p-1', 'p-elsewhere'],
      slideIds: ['s-elsewhere'],
    });

    expect(result).toEqual({ success: true, linked: { pages: 1, slides: 0, assignments: 0 } });
  });
});

describe('updateEventLinks — quiz links where quizzes are hidden', () => {
  beforeEach(() => {
    quizzesVisible.mockResolvedValue(false);
    page.findMany.mockResolvedValue([{ id: 'p-1' }]);
  });

  it('asks nothing about quizzes when none is linked or stored', async () => {
    assignment.findMany.mockResolvedValue([{ id: 'a-form', type: 'FORM' }]);

    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'], assignmentIds: ['a-form'] });

    expect(quizzesVisible).not.toHaveBeenCalled();
    // A plain replace: nothing stored is kept.
    expect(calendarEventAssignmentLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: null },
    });
    expect(calendarEventAssignmentLink.updateMany).not.toHaveBeenCalled();
  });

  it('counts the quiz links already stored on the date being written', async () => {
    const occurrence = new Date('2026-09-28T00:00:00.000Z');
    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, occurrence);

    expect(calendarEventAssignmentLink.count).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: occurrence, assignment: { type: 'QUIZ' } },
    });
  });

  it('drops a quiz being added, as it drops an id from elsewhere, and its star with it', async () => {
    assignment.findMany.mockResolvedValue([
      { id: 'a-quiz', type: 'QUIZ' },
      { id: 'a-form', type: 'FORM' },
    ]);

    const result = await updateEventLinks(
      'event-1',
      'class-1',
      { assignmentIds: ['a-quiz', 'a-form'] },
      null,
      { kind: 'assignment', id: 'a-quiz' }
    );

    expect(quizzesVisible).toHaveBeenCalledWith('class-1');
    expect(assignmentRows()).toEqual({ 'a-form': false });
    expect(result.linked.assignments).toBe(1);
  });

  it('keeps the quiz links stored on the date instead of deleting them', async () => {
    // The edit modal was never shown them, so their absence from the save is
    // not a request to remove them.
    calendarEventAssignmentLink.count.mockResolvedValue(1);
    assignment.findMany.mockResolvedValue([{ id: 'a-form', type: 'FORM' }]);

    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'], assignmentIds: ['a-form'] });

    expect(quizzesVisible).toHaveBeenCalledWith('class-1');
    expect(calendarEventAssignmentLink.deleteMany).toHaveBeenCalledWith({
      where: {
        event_id: 'event-1',
        occurrence_date: null,
        assignment: { type: { not: 'QUIZ' } },
      },
    });
    // Pages and decks are replaced as always.
    expect(calendarEventPageLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: null },
    });
  });

  it('leaves a kept quiz link its star when the save stars nothing', async () => {
    calendarEventAssignmentLink.count.mockResolvedValue(1);

    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(calendarEventAssignmentLink.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['a page', { kind: 'page' as const, id: 'p-1' }],
    ['an assignment', { kind: 'assignment' as const, id: 'a-form' }],
  ])(
    'moves the star off a kept quiz link, before inserting, when the save stars %s',
    async (_what, featured) => {
      // One star per date. On an assignment row the partial unique index would
      // refuse the insert outright if the kept row were still starred.
      calendarEventAssignmentLink.count.mockResolvedValue(1);
      assignment.findMany.mockResolvedValue([{ id: 'a-form', type: 'FORM' }]);

      await updateEventLinks(
        'event-1',
        'class-1',
        { pageIds: ['p-1'], assignmentIds: ['a-form'] },
        null,
        featured
      );

      expect(calendarEventAssignmentLink.updateMany).toHaveBeenCalledWith({
        where: {
          event_id: 'event-1',
          occurrence_date: null,
          featured: true,
          assignment: { type: 'QUIZ' },
        },
        data: { featured: false },
      });
      expect(calendarEventAssignmentLink.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
        calendarEventAssignmentLink.deleteMany.mock.invocationCallOrder[0]
      );
      expect(calendarEventAssignmentLink.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        calendarEventAssignmentLink.createMany.mock.invocationCallOrder[0]
      );

      // And exactly one created row carries the star.
      const pageRows = (
        calendarEventPageLink.createMany.mock.calls[0][0] as {
          data: Array<{ featured: boolean }>;
        }
      ).data;
      const starred = [...pageRows.map(r => r.featured), ...Object.values(assignmentRows())];
      expect(starred.filter(Boolean)).toHaveLength(1);
    }
  );

  it('places the new assignment links after the kept quiz links', async () => {
    // The read sorts on `order` alone. New rows starting again at 0 would tie
    // with the kept ones and interleave with them when quizzes show again.
    calendarEventAssignmentLink.count.mockResolvedValue(1);
    calendarEventAssignmentLink.aggregate.mockResolvedValue({ _max: { order: 2 } });
    assignment.findMany.mockResolvedValue([
      { id: 'a-form', type: 'FORM' },
      { id: 'a-repo', type: 'REPO' },
    ]);
    const occurrence = new Date('2026-09-28T00:00:00.000Z');

    await updateEventLinks(
      'event-1',
      'class-1',
      { assignmentIds: ['a-form', 'a-repo'] },
      occurrence
    );

    expect(calendarEventAssignmentLink.aggregate).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: occurrence },
      _max: { order: true },
    });
    // Asked after the delete, when the kept rows are all the date holds.
    expect(calendarEventAssignmentLink.aggregate.mock.invocationCallOrder[0]).toBeGreaterThan(
      calendarEventAssignmentLink.deleteMany.mock.invocationCallOrder[0]
    );
    const [{ data }] = calendarEventAssignmentLink.createMany.mock.calls[0] as [
      { data: Array<{ assignment_id: string; order: number }> },
    ];
    expect(data.map(row => [row.assignment_id, row.order])).toEqual([
      ['a-form', 3],
      ['a-repo', 4],
    ]);
  });

  it('numbers the new assignment links from 0 where no quiz link is kept', async () => {
    quizzesVisible.mockResolvedValue(true);
    calendarEventAssignmentLink.count.mockResolvedValue(1);
    assignment.findMany.mockResolvedValue([
      { id: 'a-quiz', type: 'QUIZ' },
      { id: 'a-form', type: 'FORM' },
    ]);

    await updateEventLinks('event-1', 'class-1', { assignmentIds: ['a-quiz', 'a-form'] });

    expect(calendarEventAssignmentLink.aggregate).not.toHaveBeenCalled();
    const [{ data }] = calendarEventAssignmentLink.createMany.mock.calls[0] as [
      { data: Array<{ assignment_id: string; order: number }> },
    ];
    expect(data.map(row => row.order)).toEqual([0, 1]);
  });

  it('replaces the stored quiz links as usual where quizzes show', async () => {
    quizzesVisible.mockResolvedValue(true);
    calendarEventAssignmentLink.count.mockResolvedValue(1);

    await updateEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, null, {
      kind: 'page',
      id: 'p-1',
    });

    expect(calendarEventAssignmentLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: null },
    });
    expect(calendarEventAssignmentLink.updateMany).not.toHaveBeenCalled();
  });
});
