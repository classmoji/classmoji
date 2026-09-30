/**
 * `addEventLinks` / `removeEventLinks` — what they refuse, and that a refusal
 * writes nothing.
 *
 * `updateEventLinks` is forgiving: it drops what it cannot link and saves the
 * rest, because the modal that calls it shows the result. These two are called
 * by something that sees only the return value, so every way a link could be
 * "saved" and then shown nowhere is a refusal instead — a resource from another
 * classroom, a recurring event with no occurrence named, a date the series
 * does not fall on. Each is pinned here against a fake Prisma, together with
 * the order the star is written in.
 *
 * What a fake cannot decide — DATE columns, the partial unique indexes, and
 * whether the calendar read finds the link afterwards — is in
 * calendar.addEventLinks.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calendarEvent = { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() };
const page = { findMany: vi.fn() };
const slide = { findMany: vi.fn() };
const assignment = { findMany: vi.fn() };
const linkTable = () => ({
  findMany: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
});
const calendarEventPageLink = linkTable();
const calendarEventSlideLink = linkTable();
const calendarEventAssignmentLink = linkTable();
const quizzesVisible = vi.fn();

/** The parent-event row lock the transaction takes before it reads anything. */
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

const { addEventLinks, removeEventLinks, assertLinkTargetsInClassroom } =
  await import('../calendar.service.ts');

/** A one-off event: its links live in the undated bucket. */
const ONE_OFF = {
  id: 'event-1',
  classroom_id: 'class-1',
  is_recurring: false,
  recurrence_rule: null,
  start_time: new Date('2026-09-21T14:00:00.000Z'),
  end_time: new Date('2026-09-21T15:00:00.000Z'),
  overrides: [],
};

/** The same event repeating every day, so which weekday a zone calls it is moot. */
const DAILY = {
  ...ONE_OFF,
  is_recurring: true,
  recurrence_rule: {
    days: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    until: '2026-10-31T00:00:00.000Z',
  },
};

const SECOND_DAY = new Date('2026-09-22T14:00:00.000Z');
const SECOND_DAY_BUCKET = new Date('2026-09-22T00:00:00.000Z');

const writes = () => [
  calendarEventPageLink.createMany,
  calendarEventSlideLink.createMany,
  calendarEventAssignmentLink.createMany,
  calendarEventPageLink.updateMany,
  calendarEventSlideLink.updateMany,
  calendarEventAssignmentLink.updateMany,
  calendarEventPageLink.deleteMany,
  calendarEventSlideLink.deleteMany,
  calendarEventAssignmentLink.deleteMany,
];

const expectNothingWritten = () => {
  for (const write of writes()) expect(write).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  calendarEvent.findFirst.mockResolvedValue({ id: 'event-1' });
  calendarEvent.findUniqueOrThrow.mockResolvedValue(ONE_OFF);
  // The lock doubles as the existence check, so it answers with the row.
  $queryRaw.mockResolvedValue([{ id: 'event-1' }]);
  page.findMany.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
  slide.findMany.mockResolvedValue([{ id: 's-1' }]);
  assignment.findMany.mockResolvedValue([{ id: 'a-1', type: 'REPO' }]);
  // An empty bucket unless a test stores something in it.
  calendarEventPageLink.findMany.mockResolvedValue([]);
  calendarEventSlideLink.findMany.mockResolvedValue([]);
  calendarEventAssignmentLink.findMany.mockResolvedValue([]);
  // No quiz link stored on the date unless a test says so.
  calendarEventAssignmentLink.count.mockResolvedValue(0);
  quizzesVisible.mockResolvedValue(true);
});

/** The date holds a quiz link (starred) and a repo assignment's link. */
const storeQuizLink = () => {
  calendarEventAssignmentLink.count.mockResolvedValue(1);
  calendarEventAssignmentLink.findMany.mockResolvedValue([
    { assignment_id: 'a-quiz', order: 0, featured: true, assignment: { type: 'QUIZ' } },
    { assignment_id: 'a-1', order: 1, featured: false, assignment: { type: 'REPO' } },
  ]);
};

describe('addEventLinks — the event has to be in this classroom', () => {
  it('refuses before validating anything when it is not', async () => {
    calendarEvent.findFirst.mockResolvedValue(null);

    await expect(
      addEventLinks('event-from-another-class', 'class-1', { pageIds: ['p-1'] })
    ).rejects.toMatchObject({ reason: 'event_not_found' });

    expect(calendarEvent.findFirst).toHaveBeenCalledWith({
      where: { id: 'event-from-another-class', classroom_id: 'class-1' },
      select: { id: true },
    });
    expect(page.findMany).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('asks again under the lock, with the classroom condition', async () => {
    $queryRaw.mockResolvedValue([]);

    await expect(addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] })).rejects.toMatchObject({
      reason: 'event_not_found',
    });

    const [strings, ...values] = $queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('FOR UPDATE');
    expect(values).toEqual(['event-1', 'class-1']);
    expectNothingWritten();
  });
});

describe('addEventLinks — every resource has to be in this classroom', () => {
  it('refuses the whole call and names the ids that are not, by kind', async () => {
    // p-2 and a-1 exist; the others are from somewhere else, or nowhere.
    page.findMany.mockResolvedValue([{ id: 'p-2' }]);
    slide.findMany.mockResolvedValue([]);

    await expect(
      addEventLinks('event-1', 'class-1', {
        pageIds: ['p-foreign', 'p-2'],
        slideIds: ['s-foreign'],
        assignmentIds: ['a-1'],
      })
    ).rejects.toMatchObject({
      reason: 'targets_not_found',
      ids: { pageIds: ['p-foreign'], slideIds: ['s-foreign'], assignmentIds: [] },
    });

    // No partial write: p-2 and a-1 were fine, and are not linked either.
    expect(client.$transaction).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('finds an assignment through its module, since a quiz or form has no repository', async () => {
    await addEventLinks('event-1', 'class-1', { assignmentIds: ['a-1'] });

    expect(assignment.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a-1'] }, module: { classroom_id: 'class-1' } },
      select: { id: true, type: true },
    });
  });

  it('refuses a quiz assignment where quizzes are hidden', async () => {
    assignment.findMany.mockResolvedValue([{ id: 'a-quiz', type: 'QUIZ' }]);
    quizzesVisible.mockResolvedValue(false);

    await expect(
      addEventLinks('event-1', 'class-1', { assignmentIds: ['a-quiz'] })
    ).rejects.toMatchObject({ reason: 'quizzes_hidden' });

    expectNothingWritten();
  });

  it('links one where they show, and does not ask when no quiz is named', async () => {
    assignment.findMany.mockResolvedValue([{ id: 'a-quiz', type: 'QUIZ' }]);
    await addEventLinks('event-1', 'class-1', { assignmentIds: ['a-quiz'] });
    expect(calendarEventAssignmentLink.createMany).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });
    expect(quizzesVisible).not.toHaveBeenCalled();
  });

  it('is the same check the pre-flight makes, so the two cannot disagree', async () => {
    page.findMany.mockResolvedValue([]);

    await expect(
      assertLinkTargetsInClassroom('class-1', { pageIds: ['p-foreign'] })
    ).rejects.toMatchObject({
      reason: 'targets_not_found',
      ids: { pageIds: ['p-foreign'], slideIds: [], assignmentIds: [] },
    });
  });
});

describe('addEventLinks — which date the links go on', () => {
  it('writes a one-off event to the undated bucket', async () => {
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(calendarEventPageLink.createMany).toHaveBeenCalledWith({
      data: [{ event_id: 'event-1', page_id: 'p-1', occurrence_date: null, order: 0 }],
    });
  });

  it('refuses a date on an event that is not recurring', async () => {
    await expect(
      addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY)
    ).rejects.toMatchObject({ reason: 'occurrence_not_allowed' });

    expectNothingWritten();
  });

  it('refuses a recurring event with no date: the undated bucket is never read', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);

    await expect(addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] })).rejects.toMatchObject({
      reason: 'occurrence_required',
    });

    expectNothingWritten();
  });

  it('keys an occurrence by the UTC date of its instant', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);

    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY);

    expect(calendarEventPageLink.createMany).toHaveBeenCalledWith({
      data: [{ event_id: 'event-1', page_id: 'p-1', occurrence_date: SECOND_DAY_BUCKET, order: 0 }],
    });
  });

  it('refuses a date the series does not fall on', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);

    // Before the first occurrence, and after the rule's `until`.
    for (const date of ['2026-09-20T14:00:00.000Z', '2026-11-02T14:00:00.000Z']) {
      await expect(
        addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, new Date(date))
      ).rejects.toMatchObject({ reason: 'not_an_occurrence' });
    }

    expectNothingWritten();
  });

  it('refuses a cancelled occurrence', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue({
      ...DAILY,
      overrides: [{ date: SECOND_DAY, is_cancelled: true }],
    });

    await expect(
      addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY)
    ).rejects.toMatchObject({ reason: 'not_an_occurrence' });

    expectNothingWritten();
  });

  it('tells the caller which occurrence a date on the right UTC day turned out to be', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);

    // Three in the morning, UTC, on the day the series meets at 14:00.
    const result = await addEventLinks(
      'event-1',
      'class-1',
      { pageIds: ['p-1'] },
      new Date('2026-09-22T03:00:00.000Z')
    );

    expect(result.occurrence).toEqual({ occurrence_date: SECOND_DAY, start_time: SECOND_DAY });
  });

  it('reports a moved occurrence at the time it now meets', async () => {
    const movedTo = new Date('2026-09-22T18:00:00.000Z');
    calendarEvent.findUniqueOrThrow.mockResolvedValue({
      ...DAILY,
      overrides: [{ date: SECOND_DAY, is_cancelled: false, new_start_time: movedTo }],
    });

    const result = await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY);

    // Still keyed, and named, by the series' own instant for that date.
    expect(result.occurrence).toEqual({ occurrence_date: SECOND_DAY, start_time: movedTo });
  });

  it('names no occurrence date for an event that has one date', async () => {
    const result = await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(result.occurrence).toEqual({ occurrence_date: null, start_time: ONE_OFF.start_time });
  });

  it('reads the event under the lock, not before it', async () => {
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      calendarEvent.findUniqueOrThrow.mock.invocationCallOrder[0]
    );
  });
});

describe('addEventLinks — adding to what is there', () => {
  it('leaves an already linked id alone and puts new rows after the stored ones', async () => {
    calendarEventPageLink.findMany.mockResolvedValue([
      { page_id: 'p-1', order: 0, featured: false },
      { page_id: 'p-0', order: 4, featured: false },
    ]);

    const result = await addEventLinks('event-1', 'class-1', { pageIds: ['p-1', 'p-2'] });

    expect(calendarEventPageLink.createMany).toHaveBeenCalledWith({
      data: [{ event_id: 'event-1', page_id: 'p-2', occurrence_date: null, order: 5 }],
    });
    expect(result.added.pageIds).toEqual(['p-2']);
    expect(result.alreadyLinked.pageIds).toEqual(['p-1']);
  });

  it('deletes nothing, in any kind', async () => {
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(calendarEventPageLink.deleteMany).not.toHaveBeenCalled();
    expect(calendarEventSlideLink.deleteMany).not.toHaveBeenCalled();
    expect(calendarEventAssignmentLink.deleteMany).not.toHaveBeenCalled();
  });

  it('treats an id named twice as one link', async () => {
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1', 'p-1'] });

    expect(calendarEventPageLink.createMany.mock.calls[0][0].data).toHaveLength(1);
  });
});

describe('addEventLinks — the star', () => {
  it('leaves the stars alone when none is asked for', async () => {
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'], slideIds: ['s-1'] });

    expect(calendarEventPageLink.updateMany).not.toHaveBeenCalled();
    expect(calendarEventSlideLink.updateMany).not.toHaveBeenCalled();
    expect(calendarEventAssignmentLink.updateMany).not.toHaveBeenCalled();
  });

  it('refuses one naming a resource this call does not link, before any query', async () => {
    await expect(
      addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, null, { kind: 'page', id: 'p-2' })
    ).rejects.toMatchObject({ reason: 'featured_not_linked' });

    expect(page.findMany).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('clears the date in all three tables before it sets the one row', async () => {
    // Set first and a star moving within a kind is a second starred row for
    // the date, which that table's partial unique index refuses.
    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'], slideIds: ['s-1'] }, null, {
      kind: 'slide',
      id: 's-1',
    });

    const cleared = { event_id: 'event-1', occurrence_date: null, featured: true };
    for (const table of [
      calendarEventPageLink,
      calendarEventSlideLink,
      calendarEventAssignmentLink,
    ]) {
      expect(table.updateMany).toHaveBeenCalledWith({ where: cleared, data: { featured: false } });
    }

    expect(calendarEventSlideLink.updateMany).toHaveBeenLastCalledWith({
      where: { event_id: 'event-1', occurrence_date: null, slide_id: 's-1' },
      data: { featured: true },
    });
    const [clear, set] = calendarEventSlideLink.updateMany.mock.invocationCallOrder;
    expect(clear).toBeLessThan(set);
    expect(calendarEventAssignmentLink.updateMany.mock.invocationCallOrder[0]).toBeLessThan(set);
  });
});

describe('what a caller is told about the date afterwards', () => {
  it('leaves a quiz link out where quizzes are hidden, as the calendar read does', async () => {
    storeQuizLink();
    quizzesVisible.mockResolvedValue(false);

    const result = await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(result.links.assignmentIds).toEqual(['a-1']);
    // The star sits on the hidden link, so there is none to report.
    expect(result.featured).toBeNull();
  });

  it('includes it where quizzes show', async () => {
    storeQuizLink();

    const result = await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(result.links.assignmentIds).toEqual(['a-quiz', 'a-1']);
    expect(result.featured).toEqual({ kind: 'assignment', id: 'a-quiz' });
  });

  it('reports the star, whichever kind holds it', async () => {
    calendarEventSlideLink.findMany.mockResolvedValue([
      { slide_id: 's-1', order: 0, featured: true },
    ]);

    const result = await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(result.featured).toEqual({ kind: 'slide', id: 's-1' });
  });
});

describe('the quiz lookup is settled before the write starts', () => {
  it('asks only when the date holds a quiz link, counted on that date', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);

    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY);

    expect(calendarEventAssignmentLink.count).toHaveBeenCalledWith({
      where: {
        event_id: 'event-1',
        occurrence_date: SECOND_DAY_BUCKET,
        assignment: { type: 'QUIZ' },
      },
    });
    expect(quizzesVisible).not.toHaveBeenCalled();
  });

  it('asks once when a quiz is both being linked and already stored', async () => {
    storeQuizLink();
    assignment.findMany.mockResolvedValue([{ id: 'a-quiz-2', type: 'QUIZ' }]);

    await addEventLinks('event-1', 'class-1', { assignmentIds: ['a-quiz-2'] });

    expect(quizzesVisible).toHaveBeenCalledTimes(1);
  });

  it('asks before the transaction opens, for an add and for a removal', async () => {
    storeQuizLink();

    await addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });
    expect(quizzesVisible.mock.invocationCallOrder[0]).toBeLessThan(
      client.$transaction.mock.invocationCallOrder[0]
    );

    vi.clearAllMocks();
    await removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });
    expect(quizzesVisible.mock.invocationCallOrder[0]).toBeLessThan(
      client.$transaction.mock.invocationCallOrder[0]
    );
  });

  it('refuses the write when the lookup fails, instead of failing after it committed', async () => {
    storeQuizLink();
    quizzesVisible.mockRejectedValue(new Error('subscription lookup failed'));

    await expect(addEventLinks('event-1', 'class-1', { pageIds: ['p-1'] })).rejects.toThrow(
      'subscription lookup failed'
    );
    await expect(removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] })).rejects.toThrow(
      'subscription lookup failed'
    );

    expect(client.$transaction).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

describe('removeEventLinks', () => {
  beforeEach(() => {
    calendarEventPageLink.findMany.mockResolvedValue([
      { page_id: 'p-1', order: 0, featured: true },
      { page_id: 'p-2', order: 1, featured: false },
    ]);
  });

  it('deletes the named links on that date and nothing else', async () => {
    const result = await removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(calendarEventPageLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: null, page_id: { in: ['p-1'] } },
    });
    expect(calendarEventSlideLink.deleteMany).not.toHaveBeenCalled();
    expect(calendarEventAssignmentLink.deleteMany).not.toHaveBeenCalled();
    expect(result.removed.pageIds).toEqual(['p-1']);
  });

  it('reports an id that was not linked instead of refusing', async () => {
    const result = await removeEventLinks('event-1', 'class-1', {
      pageIds: ['p-9'],
      slideIds: ['s-9'],
    });

    expect(result.notLinked).toEqual({ pageIds: ['p-9'], slideIds: ['s-9'], assignmentIds: [] });
    expectNothingWritten();
  });

  it('does not check the resources against the classroom: it only removes', async () => {
    await removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] });

    expect(page.findMany).not.toHaveBeenCalled();
  });

  it('refuses an event from another classroom', async () => {
    calendarEvent.findFirst.mockResolvedValue(null);

    await expect(
      removeEventLinks('event-from-another-class', 'class-1', { pageIds: ['p-1'] })
    ).rejects.toMatchObject({ reason: 'event_not_found' });

    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('still needs a date on a recurring event, and none on a one-off', async () => {
    await expect(
      removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY)
    ).rejects.toMatchObject({ reason: 'occurrence_not_allowed' });

    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);
    await expect(
      removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] })
    ).rejects.toMatchObject({ reason: 'occurrence_required' });

    expectNothingWritten();
  });

  it('reaches a link left on a date that was cancelled afterwards', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue({
      ...DAILY,
      overrides: [{ date: SECOND_DAY, is_cancelled: true }],
    });

    const result = await removeEventLinks('event-1', 'class-1', { pageIds: ['p-1'] }, SECOND_DAY);

    expect(calendarEventPageLink.deleteMany).toHaveBeenCalledWith({
      where: {
        event_id: 'event-1',
        occurrence_date: SECOND_DAY_BUCKET,
        page_id: { in: ['p-1'] },
      },
    });
    // No occurrence meets on that date any more: the date, and no start.
    expect(result.occurrence).toEqual({ occurrence_date: SECOND_DAY_BUCKET, start_time: null });
  });

  it('names the live occurrence it removed from', async () => {
    calendarEvent.findUniqueOrThrow.mockResolvedValue(DAILY);

    const result = await removeEventLinks(
      'event-1',
      'class-1',
      { pageIds: ['p-1'] },
      new Date('2026-09-22T23:59:00.000Z')
    );

    expect(result.occurrence).toEqual({ occurrence_date: SECOND_DAY, start_time: SECOND_DAY });
  });

  it('leaves a quiz link alone where quizzes are hidden, as if it were never linked', async () => {
    storeQuizLink();
    quizzesVisible.mockResolvedValue(false);

    const result = await removeEventLinks('event-1', 'class-1', {
      assignmentIds: ['a-quiz', 'a-1', 'a-9'],
    });

    expect(calendarEventAssignmentLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: null, assignment_id: { in: ['a-1'] } },
    });
    expect(result.removed.assignmentIds).toEqual(['a-1']);
    // Reported with the id that really was not there: the two look the same.
    expect(result.notLinked.assignmentIds).toEqual(['a-quiz', 'a-9']);
  });

  it('removes a quiz link where quizzes show', async () => {
    storeQuizLink();

    const result = await removeEventLinks('event-1', 'class-1', { assignmentIds: ['a-quiz'] });

    expect(calendarEventAssignmentLink.deleteMany).toHaveBeenCalledWith({
      where: { event_id: 'event-1', occurrence_date: null, assignment_id: { in: ['a-quiz'] } },
    });
    expect(result.removed.assignmentIds).toEqual(['a-quiz']);
  });
});
