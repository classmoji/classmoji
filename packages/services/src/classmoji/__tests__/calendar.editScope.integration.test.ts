/**
 * Scoped edits against a REAL Postgres.
 *
 * What cannot be mocked, and is therefore the whole point of this file: link
 * rows store `occurrence_date` as a DATE and overrides store `date` as a
 * full timestamp, and the split compares both against a JavaScript Date at
 * midnight UTC. Whether `>=` puts the boundary date on the new event or leaves
 * it behind is decided by the driver and the column types, not by the service —
 * a fake Prisma would agree with whatever we wrote. The override half matters
 * twice over: its stored value carries the occurrence's TIME of day, so the
 * boundary has to be the date, not the instant the caller happened to pass.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom →
 * calendar events → link rows, and classroom → pages). Nothing is truncated
 * and no pre-existing row is touched — the devport database holds real
 * development data.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * moduleItems.form.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as calendarService from '../calendar.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

/** Mondays. The series runs weekly; the split happens on the second one. */
const FIRST = new Date('2026-09-21T00:00:00.000Z');
const SPLIT = new Date('2026-09-28T00:00:00.000Z');
const THIRD = new Date('2026-10-05T00:00:00.000Z');

describe.skipIf(!RUN)('scoped calendar edits (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let ownerId: string;
  let pageId: string;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `caltest-${suite}`,
        login: `caltest-org-${suite}`,
      },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `caltest-${suite}`,
        git_org_id: orgId,
        name: `Calendar Scope Test ${suite}`,
        content_namespace: `caltest-${suite}`,
        content_repo: `content-caltest-${suite}`,
      },
    });
    classroomId = classroom.id;

    const user = await prisma.user.create({
      data: {
        login: `caltest-${suite}-owner`,
        email: `caltest-${suite}-owner@example.test`,
        name: `Calendar Owner ${suite}`,
      },
    });
    ownerId = user.id;

    const page = await prisma.page.create({
      data: {
        classroom: { connect: { id: classroomId } },
        creator: { connect: { id: ownerId } },
        title: `Page ${suite}`,
        slug: `page-${suite}`,
        content_path: `pages/page-${suite}`,
      },
    });
    pageId = page.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `caltest-${suite}-` } } })
      .catch(() => {});
  });

  /** A weekly Monday series with one page linked to each of three dates. */
  const makeSeries = async () => {
    const event = await calendarService.createEvent(classroomId, ownerId, {
      event_type: 'LECTURE',
      title: `Lecture ${randomUUID().slice(0, 8)}`,
      start_time: new Date('2026-09-21T14:00:00.000Z'),
      end_time: new Date('2026-09-21T15:00:00.000Z'),
      is_recurring: true,
      recurrence_rule: { days: ['monday'] },
    });

    for (const date of [FIRST, SPLIT, THIRD]) {
      await calendarService.updateEventLinks(event.id, classroomId, { pageIds: [pageId] }, date);
    }

    return event.id;
  };

  /**
   * An override on a given date, with a time on it — as the calendar writes
   * one, since an occurrence's date carries the series' time of day.
   */
  const addOverride = async (eventId: string, date: Date, hour = 9) => {
    const at = new Date(date);
    at.setUTCHours(hour, 0, 0, 0);
    return prisma.calendarEventOverride.create({
      data: { event_id: eventId, date: at, is_cancelled: true },
    });
  };

  /** Which dates each event owns an override on, as ISO date strings. */
  const overrideDatesByEvent = async (eventIds: string[]) => {
    const rows = await prisma.calendarEventOverride.findMany({
      where: { event_id: { in: eventIds } },
      select: { event_id: true, date: true },
      orderBy: { date: 'asc' },
    });
    const byEvent: Record<string, string[]> = {};
    for (const id of eventIds) byEvent[id] = [];
    for (const row of rows) byEvent[row.event_id].push(row.date.toISOString().slice(0, 10));
    return byEvent;
  };

  /** Which dates each event owns a page link on, as ISO date strings. */
  const linkDatesByEvent = async (eventIds: string[]) => {
    const rows = await prisma.calendarEventPageLink.findMany({
      where: { event_id: { in: eventIds } },
      select: { event_id: true, occurrence_date: true },
      orderBy: { occurrence_date: 'asc' },
    });
    const byEvent: Record<string, string[]> = {};
    for (const id of eventIds) byEvent[id] = [];
    for (const row of rows) {
      byEvent[row.event_id].push(row.occurrence_date!.toISOString().slice(0, 10));
    }
    return byEvent;
  };

  it('moves the links from the split date onward onto the new event', async () => {
    const originalId = await makeSeries();

    const newEvent = await calendarService.updateEventWithScope(
      originalId,
      { title: 'Moved to a new room', location: 'ECSC 004' },
      'this_and_future',
      SPLIT
    );

    expect(newEvent.id).not.toBe(originalId);

    const byEvent = await linkDatesByEvent([originalId, newEvent.id]);
    expect(byEvent[originalId]).toEqual(['2026-09-21']);
    expect(byEvent[newEvent.id]).toEqual(['2026-09-28', '2026-10-05']);
  });

  it('hands the overrides on those dates over too', async () => {
    const originalId = await makeSeries();
    // Deliberately EARLIER in the day than the split instant a caller passes,
    // which is what a bare instant comparison would miss.
    await addOverride(originalId, FIRST, 9);
    await addOverride(originalId, SPLIT, 9);
    await addOverride(originalId, THIRD, 9);

    const newEvent = await calendarService.updateEventWithScope(
      originalId,
      {},
      'this_and_future',
      new Date('2026-09-28T13:00:00.000Z')
    );

    const byEvent = await overrideDatesByEvent([originalId, newEvent.id]);
    expect(byEvent[originalId]).toEqual(['2026-09-21']);
    expect(byEvent[newEvent.id]).toEqual(['2026-09-28', '2026-10-05']);
  });

  it('leaves the undated bucket with the original event', async () => {
    // A link written with no occurrence date belongs to the event itself, not
    // to a date, so a split has no date to decide it by.
    const originalId = await makeSeries();
    await calendarService.updateEventLinks(originalId, classroomId, { pageIds: [pageId] }, null);

    const newEvent = await calendarService.updateEventWithScope(
      originalId,
      {},
      'this_and_future',
      SPLIT
    );

    const undated = await prisma.calendarEventPageLink.findMany({
      where: { occurrence_date: null, event_id: { in: [originalId, newEvent.id] } },
      select: { event_id: true },
    });
    expect(undated.map(r => r.event_id)).toEqual([originalId]);
  });

  it('removes the links on the dates a this-and-future delete removes', async () => {
    const originalId = await makeSeries();

    await calendarService.deleteEventWithScope(originalId, 'this_and_future', SPLIT);

    const byEvent = await linkDatesByEvent([originalId]);
    expect(byEvent[originalId]).toEqual(['2026-09-21']);
  });

  it('removes the overrides on those dates as well, measured from the same boundary', async () => {
    const originalId = await makeSeries();
    await addOverride(originalId, FIRST, 9);
    await addOverride(originalId, SPLIT, 9);

    await calendarService.deleteEventWithScope(
      originalId,
      'this_and_future',
      new Date('2026-09-28T13:00:00.000Z')
    );

    const byEvent = await overrideDatesByEvent([originalId]);
    expect(byEvent[originalId]).toEqual(['2026-09-21']);
  });

  it('leaves every link alone when one occurrence is cancelled', async () => {
    const originalId = await makeSeries();

    await calendarService.deleteEventWithScope(originalId, 'this_only', SPLIT);

    const byEvent = await linkDatesByEvent([originalId]);
    expect(byEvent[originalId]).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
  });

  describe('the star', () => {
    /** A second page, so two rows can compete for one date's star. */
    let otherPageId: string;

    beforeAll(async () => {
      const other = await prisma.page.create({
        data: {
          classroom: { connect: { id: classroomId } },
          creator: { connect: { id: ownerId } },
          title: `Page 2 ${suite}`,
          slug: `page-2-${suite}`,
          content_path: `pages/page-2-${suite}`,
        },
      });
      otherPageId = other.id;
    });

    /** Every starred link row these events own, across all three tables. */
    const starredRows = async (eventIds: string[]) => {
      const [pages, slides, assignments] = await Promise.all([
        prisma.calendarEventPageLink.findMany({
          where: { event_id: { in: eventIds }, featured: true },
          select: { event_id: true, page_id: true, occurrence_date: true },
        }),
        prisma.calendarEventSlideLink.findMany({
          where: { event_id: { in: eventIds }, featured: true },
          select: { event_id: true, slide_id: true },
        }),
        prisma.calendarEventAssignmentLink.findMany({
          where: { event_id: { in: eventIds }, featured: true },
          select: { event_id: true, assignment_id: true },
        }),
      ]);
      return {
        pages,
        total: pages.length + slides.length + assignments.length,
      };
    };

    const makeEvent = async (recurring: boolean) =>
      (
        await calendarService.createEvent(classroomId, ownerId, {
          event_type: 'LECTURE',
          title: `Lecture ${randomUUID().slice(0, 8)}`,
          start_time: new Date('2026-09-21T14:00:00.000Z'),
          end_time: new Date('2026-09-21T15:00:00.000Z'),
          is_recurring: recurring,
          ...(recurring ? { recurrence_rule: { days: ['monday'] } } : {}),
        })
      ).id;

    /** The other page's link row on this event, whatever date it sits on. */
    const otherLinkId = async (eventId: string) =>
      (await prisma.calendarEventPageLink.findFirstOrThrow({
        where: { event_id: eventId, page_id: otherPageId },
        select: { id: true },
      })).id;

    it('refuses a second starred row on the same date, whatever writes it', async () => {
      // The service never writes two. The rule is one per date, and the
      // database is where that has to hold for a writer added later.
      const eventId = await makeEvent(true);
      await calendarService.updateEventLinks(
        eventId,
        classroomId,
        { pageIds: [pageId, otherPageId] },
        FIRST,
        { kind: 'page', id: pageId }
      );

      await expect(
        prisma.calendarEventPageLink.update({
          where: { id: await otherLinkId(eventId) },
          data: { featured: true },
        })
      ).rejects.toThrow();
    });

    it('refuses a second starred row in the undated bucket too', async () => {
      // Postgres treats NULLs as distinct, so the dated index above does not
      // reach the bucket a non-recurring event's links live in.
      const eventId = await makeEvent(false);
      await calendarService.updateEventLinks(
        eventId,
        classroomId,
        { pageIds: [pageId, otherPageId] },
        null,
        { kind: 'page', id: pageId }
      );

      await expect(
        prisma.calendarEventPageLink.update({
          where: { id: await otherLinkId(eventId) },
          data: { featured: true },
        })
      ).rejects.toThrow();
    });

    it('waits for another save of the same event before it writes', async () => {
      // One save stars a page and another a deck: different tables, no row in
      // common, so nothing the partial indexes or Read Committed can catch.
      // What stops both stars landing is the lock this save takes on the parent
      // EVENT row — so the claim under test is that a save blocks while
      // somebody else holds that row, which is asserted here by holding it.
      const eventId = await makeEvent(false);

      let release!: () => void;
      const heldUntil = new Promise<void>(resolve => {
        release = resolve;
      });

      // FOR KEY SHARE on purpose, and it is the whole experiment: it is what
      // INSERTing a link row takes on its parent event anyway (the foreign
      // key), and two of those do not block each other. So a save that does not
      // ask for the row EXCLUSIVELY sails straight past this holder. Only the
      // service's own FOR UPDATE conflicts with it.
      const holder = prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM calendar_events WHERE id = ${eventId} FOR KEY SHARE`;
          await heldUntil;
        },
        { timeout: 20000 }
      );
      // Let the holder actually take the lock before racing against it.
      await new Promise(resolve => setTimeout(resolve, 150));

      let settled = false;
      const save = calendarService
        .updateEventLinks(eventId, classroomId, { pageIds: [pageId] }, null, {
          kind: 'page',
          id: pageId,
        })
        .then(result => {
          settled = true;
          return result;
        });

      await new Promise(resolve => setTimeout(resolve, 400));
      // Without the lock this save has long since inserted its starred row.
      expect(settled).toBe(false);

      release();
      await holder;
      await save;

      expect(settled).toBe(true);
      expect((await starredRows([eventId])).total).toBe(1);
    });

    it('hands the star to the new event when the series splits', async () => {
      // Nothing does this on purpose: the split moves whole link ROWS, and the
      // star is a column on the row it travels with.
      const eventId = await makeEvent(true);
      for (const date of [FIRST, SPLIT]) {
        await calendarService.updateEventLinks(eventId, classroomId, { pageIds: [pageId] }, date, {
          kind: 'page',
          id: pageId,
        });
      }

      const newEvent = await calendarService.updateEventWithScope(
        eventId,
        {},
        'this_and_future',
        SPLIT
      );

      const starred = await starredRows([eventId, newEvent.id]);
      expect(starred.total).toBe(2);
      expect(
        starred.pages
          .map(r => [
            r.event_id === newEvent.id ? 'new' : 'original',
            r.occurrence_date!.toISOString().slice(0, 10),
          ])
          .sort()
      ).toEqual([
        ['new', '2026-09-28'],
        ['original', '2026-09-21'],
      ]);
    });
  });
});
