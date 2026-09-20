/**
 * Scoped edits against a REAL Postgres.
 *
 * What cannot be mocked, and is therefore the whole point of this file: link
 * rows store `occurrence_date` as a DATE, and the split compares it against a
 * JavaScript Date at midnight UTC. Whether `>=` puts the boundary date on the
 * new event or leaves it behind is decided by the driver and the column type,
 * not by the service — a fake Prisma would agree with whatever we wrote.
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

  it('leaves every link alone when one occurrence is cancelled', async () => {
    const originalId = await makeSeries();

    await calendarService.deleteEventWithScope(originalId, 'this_only', SPLIT);

    const byEvent = await linkDatesByEvent([originalId]);
    expect(byEvent[originalId]).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
  });
});
