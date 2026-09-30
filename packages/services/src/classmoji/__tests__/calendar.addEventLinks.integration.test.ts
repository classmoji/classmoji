/**
 * Additive event links against a REAL Postgres.
 *
 * What cannot be mocked, and is therefore the whole point of this file:
 *   - `occurrence_date` is a DATE column and the read path matches it by the
 *     UTC date of each occurrence instant. Whether a link written for an
 *     evening class — whose UTC date is the day after the local one — is then
 *     FOUND by `getClassroomCalendar` on that occurrence is decided by the
 *     driver, the column type and the expansion together;
 *   - the unique indexes: a resource once per (event, date), in the dated
 *     bucket and in the undated one, and one starred row per date in each
 *     table. Moving the star within a kind only works in one order;
 *   - the other two kinds' rows, and the star, actually surviving an add.
 *
 * The fixture classroom has no owner and therefore no Pro subscription, so its
 * quizzes are hidden.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom →
 * calendar events → link rows, and classroom → modules → assignments, quizzes,
 * forms, pages, slides). Nothing is truncated and no pre-existing row is
 * touched — the devport database holds real development data.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * calendar.editScope.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as calendarService from '../calendar.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

/** Mondays, at the time of day the weekly series below meets. */
const FIRST_MONDAY = new Date('2026-09-21T14:00:00.000Z');
const SECOND_MONDAY = new Date('2026-09-28T14:00:00.000Z');
const A_TUESDAY = new Date('2026-09-22T14:00:00.000Z');

const EVERY_DAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

describe.skipIf(!RUN)('additive calendar event links (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let otherClassroomId: string;
  let ownerId: string;
  let pageA: string;
  let pageB: string;
  let pageC: string;
  let foreignPage: string;
  let deck: string;
  let formAssignment: string;
  let quizAssignment: string;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `caladd-${suite}`,
        login: `caladd-org-${suite}`,
      },
    });
    orgId = org.id;

    const makeClassroom = (label: string) =>
      prisma.classroom.create({
        data: {
          slug: `caladd-${label}-${suite}`,
          git_org_id: orgId,
          name: `Calendar Add ${label} ${suite}`,
          content_namespace: `caladd-${label}-${suite}`,
          content_repo: `content-caladd-${label}-${suite}`,
        },
      });
    classroomId = (await makeClassroom('main')).id;
    otherClassroomId = (await makeClassroom('other')).id;

    const user = await prisma.user.create({
      data: { email: `caladd-${suite}-owner@example.test`, name: `Calendar Add Owner ${suite}` },
    });
    ownerId = user.id;

    const makePage = async (inClassroom: string, label: string) =>
      (
        await prisma.page.create({
          data: {
            classroom: { connect: { id: inClassroom } },
            creator: { connect: { id: ownerId } },
            title: `Page ${label} ${suite}`,
            slug: `page-${label}-${suite}`,
            content_path: `pages/page-${label}-${suite}`,
            is_draft: false,
          },
        })
      ).id;
    pageA = await makePage(classroomId, 'a');
    pageB = await makePage(classroomId, 'b');
    pageC = await makePage(classroomId, 'c');
    foreignPage = await makePage(otherClassroomId, 'foreign');

    deck = (
      await prisma.slide.create({
        data: {
          classroom_id: classroomId,
          created_by: ownerId,
          title: `Deck ${suite}`,
          slug: `deck-${suite}`,
          content_path: `slides/deck-${suite}`,
          is_draft: false,
        },
      })
    ).id;

    const mod = await prisma.module.create({
      data: { classroom_id: classroomId, title: `Module ${suite}` },
    });
    const form = await prisma.form.create({
      data: {
        classroom_id: classroomId,
        title: `Form ${suite}`,
        slug: `form-${suite}`,
        created_by: ownerId,
      },
    });
    const quiz = await prisma.quiz.create({
      data: { classroom_id: classroomId, name: `Quiz ${suite}`, rubric_prompt: 'x' },
    });
    formAssignment = (
      await prisma.assignment.create({
        data: {
          module_id: mod.id,
          type: 'FORM',
          form_id: form.id,
          title: `Form assignment ${suite}`,
          is_published: true,
        },
      })
    ).id;
    quizAssignment = (
      await prisma.assignment.create({
        data: {
          module_id: mod.id,
          type: 'QUIZ',
          quiz_id: quiz.id,
          title: `Quiz assignment ${suite}`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { startsWith: `caladd-${suite}-` } } })
      .catch(() => {});
  });

  const makeEvent = async (
    overrides: Partial<Parameters<typeof calendarService.createEvent>[2]> = {},
    inClassroom = classroomId
  ) =>
    (
      await calendarService.createEvent(inClassroom, ownerId, {
        event_type: 'LECTURE',
        title: `Lecture ${randomUUID().slice(0, 8)}`,
        start_time: FIRST_MONDAY,
        end_time: new Date(FIRST_MONDAY.getTime() + 60 * 60 * 1000),
        ...overrides,
      })
    ).id;

  /** A one-off event: its links live in the undated bucket. */
  const makeOneOff = () => makeEvent();

  /** A weekly Monday series: each date's links live in that date's own bucket. */
  const makeWeekly = () => makeEvent({ is_recurring: true, recurrence_rule: { days: ['monday'] } });

  /** Every link row on the event, as `kind:date` → the ids in order (starred ones marked). */
  const storedLinks = async (eventId: string) => {
    const [pages, slides, assignments] = await Promise.all([
      prisma.calendarEventPageLink.findMany({
        where: { event_id: eventId },
        orderBy: { order: 'asc' },
      }),
      prisma.calendarEventSlideLink.findMany({
        where: { event_id: eventId },
        orderBy: { order: 'asc' },
      }),
      prisma.calendarEventAssignmentLink.findMany({
        where: { event_id: eventId },
        orderBy: { order: 'asc' },
      }),
    ]);
    const out: Record<string, string[]> = {};
    const put = (kind: string, date: Date | null, id: string, featured: boolean) => {
      const key = `${kind}:${date ? date.toISOString().slice(0, 10) : 'undated'}`;
      (out[key] ??= []).push(featured ? `${id}*` : id);
    };
    for (const l of pages) put('page', l.occurrence_date, l.page_id, l.featured);
    for (const l of slides) put('slide', l.occurrence_date, l.slide_id, l.featured);
    for (const l of assignments) put('assignment', l.occurrence_date, l.assignment_id, l.featured);
    return out;
  };

  const linkRowCount = async (eventId: string) => {
    const where = { event_id: eventId };
    const counts = await Promise.all([
      prisma.calendarEventPageLink.count({ where }),
      prisma.calendarEventSlideLink.count({ where }),
      prisma.calendarEventAssignmentLink.count({ where }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  };

  /** The event's occurrences in a window, as the staff calendar reads them. */
  const occurrences = async (eventId: string, from: string, to: string) =>
    (
      await calendarService.getClassroomCalendar(
        classroomId,
        new Date(from),
        new Date(to),
        null,
        false,
        true,
        { canSeeDrafts: true }
      )
    ).filter(item => item.id === eventId);

  it('adds to a date without disturbing its other kinds or its star', async () => {
    const eventId = await makeOneOff();
    // What the web modal saved: a page, a deck and an assignment, deck starred.
    await calendarService.updateEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageA], slideIds: [deck], assignmentIds: [formAssignment] },
      null,
      { kind: 'slide', id: deck }
    );

    const result = await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageB] });

    expect(await storedLinks(eventId)).toEqual({
      'page:undated': [pageA, pageB],
      'slide:undated': [`${deck}*`],
      'assignment:undated': [formAssignment],
    });
    expect(result).toEqual({
      added: { pageIds: [pageB], slideIds: [], assignmentIds: [] },
      alreadyLinked: { pageIds: [], slideIds: [], assignmentIds: [] },
      occurrence: { occurrence_date: null, start_time: FIRST_MONDAY },
      links: { pageIds: [pageA, pageB], slideIds: [deck], assignmentIds: [formAssignment] },
      featured: { kind: 'slide', id: deck },
    });
  });

  it('links an id once in the undated bucket, however often it is added', async () => {
    const eventId = await makeOneOff();

    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] });
    const again = await calendarService.addEventLinks(eventId, classroomId, {
      pageIds: [pageA, pageB],
    });

    expect(again.added.pageIds).toEqual([pageB]);
    expect(again.alreadyLinked.pageIds).toEqual([pageA]);
    expect(await storedLinks(eventId)).toEqual({ 'page:undated': [pageA, pageB] });
  });

  it('links an id once per date on a series, and keeps the dates apart', async () => {
    const eventId = await makeWeekly();

    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] }, FIRST_MONDAY);
    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] }, FIRST_MONDAY);
    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] }, SECOND_MONDAY);

    expect(await storedLinks(eventId)).toEqual({
      'page:2026-09-21': [pageA],
      'page:2026-09-28': [pageA],
    });
  });

  it('keeps the order ids are named in, and continues the order the date already has', async () => {
    const eventId = await makeOneOff();

    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageB, pageA] });
    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageC] });

    const rows = await prisma.calendarEventPageLink.findMany({
      where: { event_id: eventId },
      orderBy: { order: 'asc' },
      select: { page_id: true, order: true },
    });
    expect(rows).toEqual([
      { page_id: pageB, order: 0 },
      { page_id: pageA, order: 1 },
      { page_id: pageC, order: 2 },
    ]);
  });

  it('refuses a page from another classroom, and links nothing from that call', async () => {
    const eventId = await makeOneOff();

    await expect(
      calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA, foreignPage] })
    ).rejects.toMatchObject({
      reason: 'targets_not_found',
      ids: { pageIds: [foreignPage], slideIds: [], assignmentIds: [] },
    });

    expect(await linkRowCount(eventId)).toBe(0);
  });

  it('refuses an event from another classroom', async () => {
    const foreignEvent = await makeEvent({}, otherClassroomId);

    await expect(
      calendarService.addEventLinks(foreignEvent, classroomId, { pageIds: [pageA] })
    ).rejects.toMatchObject({ reason: 'event_not_found' });
    await expect(
      calendarService.removeEventLinks(foreignEvent, classroomId, { pageIds: [pageA] })
    ).rejects.toMatchObject({ reason: 'event_not_found' });

    expect(await linkRowCount(foreignEvent)).toBe(0);
  });

  it('links a form assignment, which has no repository, and refuses a hidden quiz', async () => {
    const eventId = await makeOneOff();

    await calendarService.addEventLinks(eventId, classroomId, { assignmentIds: [formAssignment] });
    await expect(
      calendarService.addEventLinks(eventId, classroomId, { assignmentIds: [quizAssignment] })
    ).rejects.toMatchObject({ reason: 'quizzes_hidden' });

    expect(await storedLinks(eventId)).toEqual({ 'assignment:undated': [formAssignment] });
  });

  it('refuses a recurring event with no date, and a date the series does not fall on', async () => {
    const eventId = await makeWeekly();

    await expect(
      calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] })
    ).rejects.toMatchObject({ reason: 'occurrence_required' });
    await expect(
      calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] }, A_TUESDAY)
    ).rejects.toMatchObject({ reason: 'not_an_occurrence' });

    expect(await linkRowCount(eventId)).toBe(0);
  });

  it('links an evening class on the UTC date of the occurrence, where the calendar reads it', async () => {
    // Every evening at 8:30 PM in New York, which is 00:30 UTC the NEXT day:
    // the first occurrence is Sep 21 on the classroom's wall and Sep 22 in the
    // column. Daily, so which weekday the server's own zone calls that instant
    // does not decide whether it is an occurrence.
    const start = new Date('2026-09-22T00:30:00.000Z');
    const eventId = await makeEvent({
      start_time: start,
      end_time: new Date('2026-09-22T01:30:00.000Z'),
      is_recurring: true,
      recurrence_rule: { days: EVERY_DAY },
    });

    const [first] = await occurrences(eventId, '2026-09-21T00:00:00.000Z', '2026-09-22T12:00:00Z');
    const occurrenceDate = (first as { occurrence_date: Date }).occurrence_date;
    expect(occurrenceDate.toISOString()).toBe(start.toISOString());
    expect(occurrenceDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })).toBe(
      '2026-09-21'
    );

    // The local date is not an occurrence at all: nothing of the series has a
    // UTC date of Sep 21.
    await expect(
      calendarService.addEventLinks(
        eventId,
        classroomId,
        { pageIds: [pageA] },
        new Date('2026-09-21T12:00:00.000Z')
      )
    ).rejects.toMatchObject({ reason: 'not_an_occurrence' });

    // The occurrence_date the read returned is.
    const added = await calendarService.addEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageA], slideIds: [deck] },
      occurrenceDate,
      { kind: 'page', id: pageA }
    );
    expect(added.occurrence).toEqual({ occurrence_date: start, start_time: start });

    // So is any other instant on that UTC day — and the caller is told which
    // occurrence it was, not handed back the time it guessed.
    const guessed = await calendarService.addEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageA] },
      new Date('2026-09-22T20:00:00.000Z')
    );
    expect(guessed.alreadyLinked.pageIds).toEqual([pageA]);
    expect(guessed.occurrence).toEqual({ occurrence_date: start, start_time: start });
    expect(await storedLinks(eventId)).toEqual({
      'page:2026-09-22': [`${pageA}*`],
      'slide:2026-09-22': [deck],
    });

    const shown = await occurrences(eventId, '2026-09-21T00:00:00.000Z', '2026-09-24T12:00:00Z');
    expect(shown.length).toBeGreaterThanOrEqual(3);
    const [linked, ...others] = shown;
    expect(linked.pages.map(l => l.page.id)).toEqual([pageA]);
    expect(linked.slides.map(l => l.slide.id)).toEqual([deck]);
    expect(linked.featured_resource).toMatchObject({ kind: 'page', id: pageA });
    // And only that one: the link belongs to a single occurrence.
    for (const other of others) {
      expect(other.pages).toEqual([]);
      expect(other.slides).toEqual([]);
      expect(other.featured_resource).toBeNull();
    }
  });

  it('moves the star within a kind and across kinds, leaving exactly one', async () => {
    const eventId = await makeWeekly();
    await calendarService.addEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageA, pageB], slideIds: [deck] },
      FIRST_MONDAY,
      { kind: 'page', id: pageA }
    );

    // Within the page table, by re-naming a page that is already linked. The
    // per-date index on that table allows one starred row: the old one has to
    // be cleared first.
    const moved = await calendarService.addEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageB] },
      FIRST_MONDAY,
      { kind: 'page', id: pageB }
    );
    expect(moved.added.pageIds).toEqual([]);
    expect(moved.alreadyLinked.pageIds).toEqual([pageB]);
    expect(moved.featured).toEqual({ kind: 'page', id: pageB });
    expect(await storedLinks(eventId)).toEqual({
      'page:2026-09-21': [pageA, `${pageB}*`],
      'slide:2026-09-21': [deck],
    });

    // Across tables.
    await calendarService.addEventLinks(eventId, classroomId, { slideIds: [deck] }, FIRST_MONDAY, {
      kind: 'slide',
      id: deck,
    });
    expect(await storedLinks(eventId)).toEqual({
      'page:2026-09-21': [pageA, pageB],
      'slide:2026-09-21': [`${deck}*`],
    });
  });

  it('moves the star in the undated bucket the same way', async () => {
    const eventId = await makeOneOff();
    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA, pageB] }, null, {
      kind: 'page',
      id: pageA,
    });

    await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageB] }, null, {
      kind: 'page',
      id: pageB,
    });

    expect(await storedLinks(eventId)).toEqual({ 'page:undated': [pageA, `${pageB}*`] });
  });

  it('refuses a star on something the call does not name, and writes nothing', async () => {
    const eventId = await makeOneOff();

    await expect(
      calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] }, null, {
        kind: 'page',
        id: pageB,
      })
    ).rejects.toMatchObject({ reason: 'featured_not_linked' });

    expect(await linkRowCount(eventId)).toBe(0);
  });

  it('removes the named links and takes the star with a starred one', async () => {
    const eventId = await makeOneOff();
    await calendarService.addEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageA, pageB], slideIds: [deck] },
      null,
      { kind: 'page', id: pageA }
    );

    const result = await calendarService.removeEventLinks(eventId, classroomId, {
      pageIds: [pageA, pageC],
    });

    expect(result).toEqual({
      removed: { pageIds: [pageA], slideIds: [], assignmentIds: [] },
      notLinked: { pageIds: [pageC], slideIds: [], assignmentIds: [] },
      occurrence: { occurrence_date: null, start_time: FIRST_MONDAY },
      links: { pageIds: [pageB], slideIds: [deck], assignmentIds: [] },
      // Nothing is promoted in its place.
      featured: null,
    });
    expect(await storedLinks(eventId)).toEqual({
      'page:undated': [pageB],
      'slide:undated': [deck],
    });
  });

  it('removes from one date of a series only, even after that date was cancelled', async () => {
    const eventId = await makeWeekly();
    for (const date of [FIRST_MONDAY, SECOND_MONDAY]) {
      await calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageA] }, date);
    }
    await prisma.calendarEventOverride.create({
      data: { event_id: eventId, date: FIRST_MONDAY, is_cancelled: true },
    });

    // Adding to the cancelled date is refused: no occurrence would show it.
    await expect(
      calendarService.addEventLinks(eventId, classroomId, { pageIds: [pageB] }, FIRST_MONDAY)
    ).rejects.toMatchObject({ reason: 'not_an_occurrence' });

    // Removing from it is not.
    const result = await calendarService.removeEventLinks(
      eventId,
      classroomId,
      { pageIds: [pageA] },
      FIRST_MONDAY
    );

    expect(result.removed.pageIds).toEqual([pageA]);
    // The date, and no start: nothing meets on it any more.
    expect(result.occurrence).toEqual({
      occurrence_date: new Date('2026-09-21T00:00:00.000Z'),
      start_time: null,
    });
    expect(await storedLinks(eventId)).toEqual({ 'page:2026-09-28': [pageA] });
  });

  it('leaves a hidden quiz link in place and reports it as not linked', async () => {
    // Stored while the classroom's quizzes showed; they are hidden now.
    const eventId = await makeOneOff();
    await calendarService.addEventLinks(eventId, classroomId, {
      assignmentIds: [formAssignment],
    });
    await prisma.calendarEventAssignmentLink.create({
      data: {
        event_id: eventId,
        assignment_id: quizAssignment,
        occurrence_date: null,
        order: 5,
        featured: true,
      },
    });

    const result = await calendarService.removeEventLinks(eventId, classroomId, {
      assignmentIds: [quizAssignment, formAssignment],
    });

    expect(result.removed.assignmentIds).toEqual([formAssignment]);
    expect(result.notLinked.assignmentIds).toEqual([quizAssignment]);
    // Not shown in what is left, star included — and still there, untouched.
    expect(result.links.assignmentIds).toEqual([]);
    expect(result.featured).toBeNull();
    expect(await storedLinks(eventId)).toEqual({ 'assignment:undated': [`${quizAssignment}*`] });
  });
});
