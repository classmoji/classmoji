/**
 * Event links to quiz and form assignments, against a REAL Postgres.
 *
 * What cannot be mocked, and is therefore the whole point of this file:
 *   - quiz and form assignments have no repository (the `assignments_type_target`
 *     CHECK), so the classroom check has to reach them through the module; a
 *     fake Prisma would agree with whichever relation the service filtered on;
 *   - the partial unique index that allows one starred assignment link per
 *     (event, date). Where quizzes are hidden a save keeps the date's quiz links
 *     rather than deleting them, and a kept link may still hold the star — the
 *     database is what proves a new star does not collide with it.
 *
 * The fixture classroom has no owner and therefore no Pro subscription, so its
 * quizzes are hidden — the path under test. The visible path needs a
 * subscription fixture and is covered by the unit tests.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom →
 * calendar events → link rows, and classroom → modules → assignments, quizzes,
 * forms, pages). Nothing is truncated and no pre-existing row is touched — the
 * devport database holds real development data.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * calendar.editScope.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as calendarService from '../calendar.service.ts';
import * as entitlementService from '../entitlement.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('calendar event links to quiz and form assignments (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let ownerId: string;
  let pageId: string;
  let quizAssignmentId: string;
  let formAssignmentId: string;
  let foreignAssignmentId: string;

  /** A module holding one quiz assignment and one form assignment, in a classroom. */
  const makeCoursework = async (inClassroom: string, label: string) => {
    const mod = await prisma.module.create({
      data: { classroom_id: inClassroom, title: `Module ${label} ${suite}` },
    });
    const quiz = await prisma.quiz.create({
      data: { classroom_id: inClassroom, name: `Quiz ${label} ${suite}`, rubric_prompt: 'x' },
    });
    const form = await prisma.form.create({
      data: {
        classroom_id: inClassroom,
        title: `Form ${label} ${suite}`,
        slug: `form-${label}-${suite}`,
        created_by: ownerId,
      },
    });
    const quizAssignment = await prisma.assignment.create({
      data: { module_id: mod.id, type: 'QUIZ', quiz_id: quiz.id, title: `Quiz ${label}` },
    });
    const formAssignment = await prisma.assignment.create({
      data: { module_id: mod.id, type: 'FORM', form_id: form.id, title: `Form ${label}` },
    });
    return { quizAssignmentId: quizAssignment.id, formAssignmentId: formAssignment.id };
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `callinks-${suite}`,
        login: `callinks-org-${suite}`,
      },
    });
    orgId = org.id;

    const makeClassroom = (label: string) =>
      prisma.classroom.create({
        data: {
          slug: `callinks-${label}-${suite}`,
          git_org_id: orgId,
          name: `Calendar Links ${label} ${suite}`,
          content_namespace: `callinks-${label}-${suite}`,
          content_repo: `content-callinks-${label}-${suite}`,
        },
      });
    classroomId = (await makeClassroom('main')).id;
    const otherClassroomId = (await makeClassroom('other')).id;

    const user = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `callinks-${suite}-owner`,
            username: `callinks-${suite}-owner`,
          },
        },
        email: `callinks-${suite}-owner@example.test`,
        name: `Calendar Links Owner ${suite}`,
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

    ({ quizAssignmentId, formAssignmentId } = await makeCoursework(classroomId, 'main'));
    foreignAssignmentId = (await makeCoursework(otherClassroomId, 'other')).formAssignmentId;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({
        where: {
          accounts: {
            some: { provider_id: 'github', username: { startsWith: `callinks-${suite}-` } },
          },
        },
      })
      .catch(() => {});
  });

  /** A one-off event: its links live in the undated bucket. */
  const makeEvent = async () =>
    (
      await calendarService.createEvent(classroomId, ownerId, {
        event_type: 'LECTURE',
        title: `Lecture ${randomUUID().slice(0, 8)}`,
        start_time: new Date('2026-09-21T14:00:00.000Z'),
        end_time: new Date('2026-09-21T15:00:00.000Z'),
      })
    ).id;

  /** A weekly event: each date's links live in that date's own bucket. */
  const makeWeeklyEvent = async () =>
    (
      await calendarService.createEvent(classroomId, ownerId, {
        event_type: 'LECTURE',
        title: `Lecture ${randomUUID().slice(0, 8)}`,
        start_time: new Date('2026-09-21T14:00:00.000Z'),
        end_time: new Date('2026-09-21T15:00:00.000Z'),
        is_recurring: true,
        recurrence_rule: { days: ['monday'] },
      })
    ).id;

  /** The event's assignment link rows, keyed by assignment id. */
  const assignmentLinks = async (eventId: string) => {
    const rows = await prisma.calendarEventAssignmentLink.findMany({
      where: { event_id: eventId },
      select: { id: true, assignment_id: true, occurrence_date: true, featured: true, order: true },
    });
    return Object.fromEntries(rows.map(row => [row.assignment_id, row]));
  };

  /** Starred link rows on the event, across all three tables. */
  const starCount = async (eventId: string) => {
    const where = { event_id: eventId, featured: true };
    const counts = await Promise.all([
      prisma.calendarEventPageLink.count({ where }),
      prisma.calendarEventSlideLink.count({ where }),
      prisma.calendarEventAssignmentLink.count({ where }),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  };

  /** A starred quiz link, as one saved while the classroom's quizzes showed. */
  const storeStarredQuizLink = (eventId: string) =>
    prisma.calendarEventAssignmentLink.create({
      data: {
        event_id: eventId,
        assignment_id: quizAssignmentId,
        occurrence_date: null,
        order: 2,
        featured: true,
      },
    });

  it('starts from a classroom whose quizzes are hidden', async () => {
    expect(await entitlementService.quizzesVisible(classroomId)).toBe(false);
  });

  it('links a form assignment, which has no repository, and lets it carry the star', async () => {
    const eventId = await makeEvent();

    const result = await calendarService.updateEventLinks(
      eventId,
      classroomId,
      { assignmentIds: [formAssignmentId] },
      null,
      { kind: 'assignment', id: formAssignmentId }
    );

    expect(result.linked.assignments).toBe(1);
    expect((await assignmentLinks(eventId))[formAssignmentId]).toMatchObject({ featured: true });
  });

  it('drops an assignment from another classroom', async () => {
    const eventId = await makeEvent();

    const result = await calendarService.updateEventLinks(eventId, classroomId, {
      assignmentIds: [formAssignmentId, foreignAssignmentId],
    });

    expect(result.linked.assignments).toBe(1);
    expect(Object.keys(await assignmentLinks(eventId))).toEqual([formAssignmentId]);
  });

  it('adds no quiz link while quizzes are hidden', async () => {
    const eventId = await makeEvent();

    const result = await calendarService.updateEventLinks(eventId, classroomId, {
      assignmentIds: [quizAssignmentId, formAssignmentId],
    });

    expect(result.linked.assignments).toBe(1);
    expect(Object.keys(await assignmentLinks(eventId))).toEqual([formAssignmentId]);
  });

  it('keeps a stored quiz link, star and all, through a save that stars nothing', async () => {
    const eventId = await makeEvent();
    const stored = await storeStarredQuizLink(eventId);

    await calendarService.updateEventLinks(eventId, classroomId, { pageIds: [pageId] });

    // The same row, not a recreated one, still starred and in its place.
    expect((await assignmentLinks(eventId))[quizAssignmentId]).toEqual({
      id: stored.id,
      assignment_id: quizAssignmentId,
      occurrence_date: null,
      featured: true,
      order: 2,
    });
  });

  it('moves the star off a kept quiz link without tripping the one-star index', async () => {
    // Without the clear, the starred form row would be a second starred
    // assignment row in the undated bucket, which the partial unique index
    // refuses — the whole save would fail.
    const eventId = await makeEvent();
    const stored = await storeStarredQuizLink(eventId);

    await calendarService.updateEventLinks(
      eventId,
      classroomId,
      // The quiz id is sent too, as a client could; it is dropped, not duplicated.
      { pageIds: [pageId], assignmentIds: [formAssignmentId, quizAssignmentId] },
      null,
      { kind: 'assignment', id: formAssignmentId }
    );

    const links = await assignmentLinks(eventId);
    expect(links[quizAssignmentId]).toEqual({
      id: stored.id,
      assignment_id: quizAssignmentId,
      occurrence_date: null,
      featured: false,
      order: 2,
    });
    // After the kept row, not tied with it: the read sorts on `order` alone.
    expect(links[formAssignmentId]).toMatchObject({ featured: true, order: 3 });
    expect(await starCount(eventId)).toBe(1);
  });

  it('does the same on a dated occurrence, under the per-date one-star index', async () => {
    // A dated bucket is held to one starred assignment row by
    // `calendar_event_assignment_links_featured` (event, date), not by the
    // null-date index the cases above run into.
    const eventId = await makeWeeklyEvent();
    const monday = new Date('2026-09-28T00:00:00.000Z');
    const stored = await prisma.calendarEventAssignmentLink.create({
      data: {
        event_id: eventId,
        assignment_id: quizAssignmentId,
        occurrence_date: monday,
        order: 1,
        featured: true,
      },
    });

    await calendarService.updateEventLinks(
      eventId,
      classroomId,
      { assignmentIds: [formAssignmentId, quizAssignmentId] },
      // With a time of day, as a caller may send it; the write keeps the date.
      new Date('2026-09-28T14:00:00.000Z'),
      { kind: 'assignment', id: formAssignmentId }
    );

    const links = await assignmentLinks(eventId);
    expect(links[quizAssignmentId]).toEqual({
      id: stored.id,
      assignment_id: quizAssignmentId,
      occurrence_date: monday,
      featured: false,
      order: 1,
    });
    expect(links[formAssignmentId]).toMatchObject({
      occurrence_date: monday,
      featured: true,
      order: 2,
    });
    expect(await starCount(eventId)).toBe(1);
  });

  it('moves it the same way when the new star is on a page', async () => {
    const eventId = await makeEvent();
    await storeStarredQuizLink(eventId);

    await calendarService.updateEventLinks(eventId, classroomId, { pageIds: [pageId] }, null, {
      kind: 'page',
      id: pageId,
    });

    expect((await assignmentLinks(eventId))[quizAssignmentId]).toMatchObject({ featured: false });
    expect(await starCount(eventId)).toBe(1);
  });

  // The read side, against the real select: a link to a form assignment shows
  // on a student's calendar only once the student-visibility rule admits it —
  // the assignment published AND the form out of draft. Staff always see it,
  // marked as not yet visible to students. Runs last: it publishes the shared
  // form assignment.
  it('shows a student a form link only once the form is out of draft, and flags it for staff', async () => {
    const eventId = await makeEvent();
    await prisma.calendarEventAssignmentLink.create({
      data: { event_id: eventId, assignment_id: formAssignmentId, occurrence_date: null, order: 0 },
    });
    const start = new Date('2026-09-20T00:00:00.000Z');
    const end = new Date('2026-09-23T00:00:00.000Z');
    const linkedIds = async (canSeeDrafts: boolean) => {
      const items = await calendarService.getClassroomCalendar(
        classroomId,
        start,
        end,
        null,
        false,
        canSeeDrafts,
        { canSeeDrafts }
      );
      const event = items.find(i => i.id === eventId) as unknown as {
        assignments: Array<{ assignment: { id: string; is_published: boolean } }>;
      };
      return event.assignments.map(a => [a.assignment.id, a.assignment.is_published]);
    };

    // Assignment published, form still a draft (the fixture's default status).
    await prisma.assignment.update({
      where: { id: formAssignmentId },
      data: { is_published: true },
    });
    expect(await linkedIds(false)).toEqual([]);
    expect(await linkedIds(true)).toEqual([[formAssignmentId, false]]);

    // The form opens: now students see it too.
    const { form_id: formId } = await prisma.assignment.findUniqueOrThrow({
      where: { id: formAssignmentId },
      select: { form_id: true },
    });
    await prisma.form.update({ where: { id: formId! }, data: { status: 'OPEN' } });
    expect(await linkedIds(false)).toEqual([[formAssignmentId, true]]);
  });
});
