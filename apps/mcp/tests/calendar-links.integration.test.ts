/**
 * Calendar event links over the real server — calendar_event_link_add,
 * calendar_event_link_remove, and the link inputs on calendar_event_create.
 *
 * Three things only a spawned server against a real database can show:
 *
 *   S1 (cross-classroom) — an event in the caller's classroom aimed at another
 *   classroom's page or assignment, and another classroom's event aimed at with
 *   the caller's own page, both come back as the uniform `not_found`, with no
 *   link row written and, on create, no event left behind.
 *
 *   S4 (roles) — the gate is the calendar update gate: a student is refused,
 *   an assistant may change the events they created and no others, a teacher
 *   and an owner may change any.
 *
 *   The read — a link added to ONE occurrence of a recurring evening event,
 *   using the occurrence_date list_calendar_range returned, is then returned by
 *   list_calendar_range on that occurrence and on no other. This is the case
 *   the tool exists for: that occurrence's UTC date is the day after its local
 *   one, and a link keyed by the wrong date is saved and shown nowhere.
 *
 * Fixtures are resolved here rather than through helpers' loadFixtures: the
 * classrooms by org/slug, the users by the ids the dev mint returns. Rows this
 * file needs and the seed lacks are created here and deleted in afterAll
 * (create-and-clean).
 *
 * Identity discipline: timofei7 holds OWNER+ASSISTANT+STUDENT and passes every
 * role gate — used ONLY for OWNER-allow paths. Every denial uses a single-role
 * identity, and the first test proves they are single-role.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callTool,
  CleanupStack,
  deleteMcpAuditRows,
  deleteMintedTokens,
  deleteTestNotifications,
  DEV_REF,
  expectAuditRow,
  expectForbidden,
  expectScopedNotFound,
  getPrisma,
  mintToken,
  startServer,
  type MintedToken,
  type ServerHandle,
} from './helpers.ts';

const prisma = getPrisma();
const suiteStart = new Date();
const cleanup = new CleanupStack();

let server: ServerHandle;

let ownerMint: MintedToken; // timofei7 — OWNER-allow paths ONLY
let teacherMint: MintedToken; // fake-teacher — TEACHER (single role)
let taMint: MintedToken; // fake-ta — ASSISTANT (single role)
let studentMint: MintedToken; // fake-student-1 — STUDENT (single role)

let owner: string;
let teacher: string;
let ta: string;
let student: string;

let devClassroomId: string;
let foreignClassroomId: string;

let devPageId: string;
let secondDevPageId: string;
let foreignPageId: string;
let foreignEventId: string;
let devAssignmentId: string;
let foreignAssignmentId: string;

const TITLES = {
  devPage: 'MCP-CAL Dev Page',
  secondDevPage: 'MCP-CAL Second Dev Page',
  foreignPage: 'MCP-CAL Foreign Page',
  foreignEvent: 'MCP-CAL Foreign Event',
  ownerEvent: 'MCP-CAL Owner Event',
  taEvent: 'MCP-CAL TA Event',
  series: 'MCP-CAL Evening Series',
  createdWithLinks: 'MCP-CAL Created With Links',
  refusedCreate: 'MCP-CAL Refused Create',
} as const;

/** A random uuid: an id that exists nowhere. */
const NOWHERE = '5a1b0c1e-0000-4000-8000-00000000c0de';

const classroomBy = (org: string, slug: string) =>
  prisma.classroom.findFirstOrThrow({
    where: { slug, git_organization: { login: org } },
    select: { id: true },
  });

const linkRowCount = async (eventId: string) => {
  const where = { event_id: eventId };
  const counts = await Promise.all([
    prisma.calendarEventPageLink.count({ where }),
    prisma.calendarEventSlideLink.count({ where }),
    prisma.calendarEventAssignmentLink.count({ where }),
  ]);
  return counts.reduce((a, b) => a + b, 0);
};

/**
 * The `data` of the latest audit row one tool wrote for one event in this run.
 * `notLinked`, when given, picks the row of the call that reported exactly
 * those ids as not linked.
 */
const auditData = async (
  userId: string,
  eventId: string,
  tool: string,
  notLinked?: Record<string, string[]>
) => {
  const rows = await prisma.auditLog.findMany({
    where: {
      user_id: userId,
      resource_type: 'CALENDAR',
      resource_id: eventId,
      timestamp: { gte: suiteStart },
    },
    orderBy: { timestamp: 'desc' },
  });
  const match = rows
    .map(row => row.data as Record<string, unknown> | null)
    .find(
      data =>
        data?.tool === tool &&
        (!notLinked || JSON.stringify(data.not_linked) === JSON.stringify(notLinked))
    );
  expect(match, `audit row missing: ${tool} on ${eventId}`).toBeTruthy();
  return match;
};

interface CalendarRow {
  id: string;
  occurrence_date: string | null;
  pages: Array<{ id: string }>;
  assignments: Array<{ assignment: { id: string } }>;
  featured_resource: { kind: string; id: string } | null;
}

/** The rows list_calendar_range returns for one event, in date order. */
const occurrencesOf = async (token: string, eventId: string, start: string, end: string) => {
  const listed = await callTool(token, 'list_calendar_range', { classroom: DEV_REF, start, end });
  expect(listed.isError).toBe(false);
  return (listed.payload.events as CalendarRow[]).filter(row => row.id === eventId);
};

/** Create an event through the tool and register it for cleanup. */
const createEvent = async (token: string, args: Record<string, unknown>) => {
  const created = await callTool(token, 'calendar_event_create', { classroom: DEV_REF, ...args });
  expect(created.isError, JSON.stringify(created.payload)).toBe(false);
  const eventId = (created.payload.event as { id: string }).id;
  cleanup.add(`calendar event ${String(args.title)}`, () =>
    prisma.calendarEvent.deleteMany({ where: { id: eventId } })
  );
  return { eventId, payload: created.payload };
};

beforeAll(async () => {
  [devClassroomId, foreignClassroomId] = (
    await Promise.all([
      classroomBy('classmoji-development', 'classmoji-dev-winter-2025'),
      classroomBy('dev-org', 'classmoji-other-class'),
    ])
  ).map(c => c.id);

  // Defensive pre-clean so a crashed earlier run cannot leave rows behind.
  await prisma.calendarEvent.deleteMany({ where: { title: { in: Object.values(TITLES) } } });
  await prisma.page.deleteMany({ where: { title: { in: Object.values(TITLES) } } });

  server = await startServer();

  [ownerMint, teacherMint, taMint, studentMint] = await Promise.all([
    mintToken({ login: 'timofei7' }),
    mintToken({ login: 'fake-teacher' }),
    mintToken({ login: 'fake-ta' }),
    mintToken({ login: 'fake-student-1' }),
  ]);
  owner = ownerMint.access_token;
  teacher = teacherMint.access_token;
  ta = taMint.access_token;
  student = studentMint.access_token;

  const makePage = async (classroomId: string, title: string, slug: string) => {
    const page = await prisma.page.create({
      data: {
        classroom_id: classroomId,
        title,
        content_path: `pages/${slug}`,
        created_by: ownerMint.user_id,
        // Published, so the student read below is shown the link too.
        is_draft: false,
      },
    });
    cleanup.add(`page ${title}`, () => prisma.page.deleteMany({ where: { id: page.id } }));
    return page.id;
  };
  devPageId = await makePage(devClassroomId, TITLES.devPage, 'mcp-cal-dev-page');
  secondDevPageId = await makePage(devClassroomId, TITLES.secondDevPage, 'mcp-cal-second-dev-page');
  foreignPageId = await makePage(foreignClassroomId, TITLES.foreignPage, 'mcp-cal-foreign-page');

  const foreignEvent = await prisma.calendarEvent.create({
    data: {
      classroom_id: foreignClassroomId,
      created_by: ownerMint.user_id,
      event_type: 'LECTURE',
      title: TITLES.foreignEvent,
      start_time: new Date('2027-03-01T15:00:00Z'),
      end_time: new Date('2027-03-01T16:00:00Z'),
    },
  });
  foreignEventId = foreignEvent.id;
  cleanup.add('foreign calendar event', () =>
    prisma.calendarEvent.deleteMany({ where: { id: foreignEventId } })
  );

  // Seeded assignments, found through the module as the service finds them.
  devAssignmentId = (
    await prisma.assignment.findFirstOrThrow({
      where: { title: 'Hello World Part 1', module: { classroom_id: devClassroomId } },
      select: { id: true },
    })
  ).id;
  foreignAssignmentId = (
    await prisma.assignment.findFirstOrThrow({
      where: { title: 'Other Assignment 1', module: { classroom_id: foreignClassroomId } },
      select: { id: true },
    })
  ).id;
}, 300_000);

afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    try {
      await deleteMcpAuditRows(
        suiteStart,
        [ownerMint, teacherMint, taMint, studentMint].filter(Boolean).map(m => m.user_id)
      );
      await deleteTestNotifications(suiteStart, [devClassroomId, foreignClassroomId]);
      await deleteMintedTokens();
    } finally {
      await server?.stop();
      await prisma.$disconnect();
    }
  }
}, 120_000);

describe('test identities', () => {
  it('the denial identities hold exactly one role in the dev classroom', async () => {
    const rolesOf = async (userId: string) =>
      (
        await prisma.classroomMembership.findMany({
          where: { classroom_id: devClassroomId, user_id: userId },
          select: { role: true },
        })
      ).map(m => m.role);

    expect(await rolesOf(teacherMint.user_id)).toEqual(['TEACHER']);
    expect(await rolesOf(taMint.user_id)).toEqual(['ASSISTANT']);
    expect(await rolesOf(studentMint.user_id)).toEqual(['STUDENT']);
  });
});

describe('S1 — cross-classroom', () => {
  let ownerEventId: string;

  beforeAll(async () => {
    ({ eventId: ownerEventId } = await createEvent(owner, {
      title: TITLES.ownerEvent,
      event_type: 'LECTURE',
      start_time: '2027-03-01T10:00:00-05:00',
      end_time: '2027-03-01T11:00:00-05:00',
    }));
  });

  it('own event + a FOREIGN page or assignment: not_found, and nothing is linked', async () => {
    const foreign = await callTool(teacher, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: ownerEventId,
      // The caller's own page rides along: the refusal is for the whole call.
      page_ids: [devPageId, foreignPageId],
    });
    expectScopedNotFound(foreign, 'calendar_event_link_add (foreign page)');
    expect(foreign.payload.not_found).toEqual({
      pages: [foreignPageId],
      slides: [],
      assignments: [],
    });

    // Indistinguishable from an id that exists nowhere, but for the id echoed.
    const nowhere = await callTool(teacher, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: ownerEventId,
      page_ids: [NOWHERE],
    });
    expectScopedNotFound(nowhere, 'calendar_event_link_add (unknown page)');
    expect(nowhere.payload.message).toBe(foreign.payload.message);

    expectScopedNotFound(
      await callTool(teacher, 'calendar_event_link_add', {
        classroom: DEV_REF,
        event_id: ownerEventId,
        assignment_ids: [foreignAssignmentId],
      }),
      'calendar_event_link_add (foreign assignment)'
    );

    expect(await linkRowCount(ownerEventId)).toBe(0);
  });

  it('a FOREIGN event + own page: not_found for add and remove, the event untouched', async () => {
    const add = await callTool(teacher, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: foreignEventId,
      page_ids: [devPageId],
    });
    expectScopedNotFound(add, 'calendar_event_link_add (foreign event)');

    const unknown = await callTool(teacher, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: NOWHERE,
      page_ids: [devPageId],
    });
    expect(unknown.payload).toEqual(add.payload);

    expectScopedNotFound(
      await callTool(teacher, 'calendar_event_link_remove', {
        classroom: DEV_REF,
        event_id: foreignEventId,
        page_ids: [devPageId],
      }),
      'calendar_event_link_remove (foreign event)'
    );

    expect(await linkRowCount(foreignEventId)).toBe(0);
  });

  it('calendar_event_create with a FOREIGN page: not_found, and no event is left behind', async () => {
    expectScopedNotFound(
      await callTool(teacher, 'calendar_event_create', {
        classroom: DEV_REF,
        title: TITLES.refusedCreate,
        event_type: 'LECTURE',
        start_time: '2027-03-03T10:00:00-05:00',
        end_time: '2027-03-03T11:00:00-05:00',
        page_ids: [foreignPageId],
      }),
      'calendar_event_create (foreign page)'
    );

    expect(await prisma.calendarEvent.count({ where: { title: TITLES.refusedCreate } })).toBe(0);
  });
});

describe('S4 — the link tools share the calendar update gate', () => {
  let ownerEventId: string;
  let taEventId: string;

  beforeAll(async () => {
    ({ eventId: ownerEventId } = await createEvent(owner, {
      title: TITLES.ownerEvent,
      event_type: 'LECTURE',
      start_time: '2027-03-04T10:00:00-05:00',
      end_time: '2027-03-04T11:00:00-05:00',
    }));
    ({ eventId: taEventId } = await createEvent(ta, {
      title: TITLES.taEvent,
      event_type: 'OFFICE_HOURS',
      start_time: '2027-03-04T13:00:00-05:00',
      end_time: '2027-03-04T14:00:00-05:00',
    }));
  });

  it('STUDENT is refused both tools', async () => {
    for (const tool of ['calendar_event_link_add', 'calendar_event_link_remove']) {
      expectForbidden(
        await callTool(student, tool, {
          classroom: DEV_REF,
          event_id: ownerEventId,
          page_ids: [devPageId],
        }),
        `${tool} as student`,
        'INSUFFICIENT_ROLE'
      );
    }
    expect(await linkRowCount(ownerEventId)).toBe(0);
  });

  it('ASSISTANT may change their own event, not somebody else’s', async () => {
    for (const tool of ['calendar_event_link_add', 'calendar_event_link_remove']) {
      expectForbidden(
        await callTool(ta, tool, {
          classroom: DEV_REF,
          event_id: ownerEventId,
          page_ids: [devPageId],
        }),
        `${tool} as assistant on another creator’s event`,
        'INSUFFICIENT_ROLE'
      );
    }
    expect(await linkRowCount(ownerEventId)).toBe(0);

    const own = await callTool(ta, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: taEventId,
      page_ids: [devPageId],
    });
    expect(own.isError, JSON.stringify(own.payload)).toBe(false);
    expect(own.payload.added).toEqual({ pages: [devPageId], slides: [], assignments: [] });
    await expectAuditRow({
      userId: taMint.user_id,
      classroomId: devClassroomId,
      role: 'ASSISTANT',
      resourceType: 'CALENDAR',
      action: 'UPDATE',
      resourceId: taEventId,
      tool: 'calendar_event_link_add',
      since: suiteStart,
    });
    // The row names the resources, as the other link tools' rows do.
    expect(await auditData(taMint.user_id, taEventId, 'calendar_event_link_add')).toMatchObject({
      added: { pages: [devPageId], slides: [], assignments: [] },
      already_linked: { pages: [], slides: [], assignments: [] },
      occurrence_date: null,
    });

    // And unlink from it: the same gate, on the other tool.
    const ownRemove = await callTool(ta, 'calendar_event_link_remove', {
      classroom: DEV_REF,
      event_id: taEventId,
      page_ids: [devPageId],
    });
    expect(ownRemove.isError, JSON.stringify(ownRemove.payload)).toBe(false);
    expect(ownRemove.payload.removed).toEqual({ pages: [devPageId], slides: [], assignments: [] });
    expect(await linkRowCount(taEventId)).toBe(0);
    await expectAuditRow({
      userId: taMint.user_id,
      classroomId: devClassroomId,
      role: 'ASSISTANT',
      resourceType: 'CALENDAR',
      action: 'UPDATE',
      resourceId: taEventId,
      tool: 'calendar_event_link_remove',
      since: suiteStart,
    });

    // A repeat removes nothing, says so, and is still recorded.
    const repeat = await callTool(ta, 'calendar_event_link_remove', {
      classroom: DEV_REF,
      event_id: taEventId,
      page_ids: [devPageId, secondDevPageId],
    });
    expect(repeat.isError, JSON.stringify(repeat.payload)).toBe(false);
    expect(repeat.payload.not_linked).toEqual({
      pages: [devPageId, secondDevPageId],
      slides: [],
      assignments: [],
    });
    expect(
      await auditData(taMint.user_id, taEventId, 'calendar_event_link_remove', {
        pages: [devPageId, secondDevPageId],
        slides: [],
        assignments: [],
      })
    ).toMatchObject({ removed: { pages: [], slides: [], assignments: [] } });

    // Back on, for the cases below.
    const relinked = await callTool(ta, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: taEventId,
      page_ids: [devPageId],
    });
    expect(relinked.isError, JSON.stringify(relinked.payload)).toBe(false);
  });

  it('TEACHER and OWNER may change anyone’s event, and the adds accumulate', async () => {
    // TEACHER adds an assignment to the assistant's event: the page stays.
    const byTeacher = await callTool(teacher, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: taEventId,
      assignment_ids: [devAssignmentId],
      featured: { kind: 'assignment', id: devAssignmentId },
    });
    expect(byTeacher.isError, JSON.stringify(byTeacher.payload)).toBe(false);
    expect(byTeacher.payload.links).toEqual({
      pages: [devPageId],
      slides: [],
      assignments: [devAssignmentId],
    });
    expect(byTeacher.payload.featured_resource).toEqual({
      kind: 'assignment',
      id: devAssignmentId,
    });

    // OWNER adds a second page, and re-names the first: reported, not duplicated.
    const byOwner = await callTool(owner, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: taEventId,
      page_ids: [devPageId, secondDevPageId],
    });
    expect(byOwner.isError, JSON.stringify(byOwner.payload)).toBe(false);
    expect(byOwner.payload.added).toEqual({
      pages: [secondDevPageId],
      slides: [],
      assignments: [],
    });
    expect(byOwner.payload.already_linked).toEqual({
      pages: [devPageId],
      slides: [],
      assignments: [],
    });
    // The star the teacher set is still there: nothing in this call named one.
    expect(byOwner.payload.featured_resource).toEqual({
      kind: 'assignment',
      id: devAssignmentId,
    });
    expect(await linkRowCount(taEventId)).toBe(3);

    // TEACHER removes the starred assignment; the star goes with it.
    const removed = await callTool(teacher, 'calendar_event_link_remove', {
      classroom: DEV_REF,
      event_id: taEventId,
      assignment_ids: [devAssignmentId],
      slide_ids: [NOWHERE],
    });
    expect(removed.isError, JSON.stringify(removed.payload)).toBe(false);
    expect(removed.payload.removed).toEqual({
      pages: [],
      slides: [],
      assignments: [devAssignmentId],
    });
    expect(removed.payload.not_linked).toEqual({ pages: [], slides: [NOWHERE], assignments: [] });
    expect(removed.payload.featured_resource).toBeNull();
    await expectAuditRow({
      userId: teacherMint.user_id,
      classroomId: devClassroomId,
      role: 'TEACHER',
      resourceType: 'CALENDAR',
      action: 'UPDATE',
      resourceId: taEventId,
      tool: 'calendar_event_link_remove',
      since: suiteStart,
    });
  });
});

describe('links on one occurrence of a recurring event', () => {
  // Every evening at 7:30 PM in New York for a week: 00:30 UTC the NEXT day.
  // Daily, so which weekday the server's own zone calls that instant does not
  // decide whether it is an occurrence.
  const FIRST_OCCURRENCE = '2027-03-02T00:30:00.000Z';
  const WINDOW = { start: '2027-02-27', end: '2027-03-05' };
  let seriesId: string;

  beforeAll(async () => {
    ({ eventId: seriesId } = await createEvent(owner, {
      title: TITLES.series,
      event_type: 'LECTURE',
      start_time: FIRST_OCCURRENCE,
      end_time: '2027-03-02T01:30:00.000Z',
      is_recurring: true,
      recurrence_rule: {
        days: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
        until: '2027-03-08T00:00:00.000Z',
      },
    }));
  });

  it('calendar_event_create refuses links on a series and creates nothing', async () => {
    const refused = await callTool(owner, 'calendar_event_create', {
      classroom: DEV_REF,
      title: TITLES.refusedCreate,
      event_type: 'LECTURE',
      start_time: FIRST_OCCURRENCE,
      end_time: '2027-03-02T01:30:00.000Z',
      is_recurring: true,
      recurrence_rule: { days: ['monday'] },
      page_ids: [devPageId],
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe('invalid_params');
    expect(refused.payload.message).toContain('calendar_event_link_add');
    expect(await prisma.calendarEvent.count({ where: { title: TITLES.refusedCreate } })).toBe(0);
  });

  it('needs an occurrence_date, and one the series falls on', async () => {
    const none = await callTool(owner, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [devPageId],
    });
    expect(none.isError).toBe(true);
    expect(none.payload.error).toBe('invalid_params');

    // The first occurrence's LOCAL date. Nothing of the series has that UTC date.
    const localDate = await callTool(owner, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [devPageId],
      occurrence_date: '2027-03-01T12:00:00.000Z',
    });
    expect(localDate.isError).toBe(true);
    expect(localDate.payload.error).toBe('invalid_params');

    expect(await linkRowCount(seriesId)).toBe(0);
  });

  it('a link added with the occurrence_date the read returned is read back on that occurrence only', async () => {
    const before = await occurrencesOf(owner, seriesId, WINDOW.start, WINDOW.end);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(before[0].occurrence_date).toBe(FIRST_OCCURRENCE);
    expect(before.every(row => row.pages.length === 0)).toBe(true);

    const added = await callTool(owner, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [devPageId],
      assignment_ids: [devAssignmentId],
      occurrence_date: before[0].occurrence_date,
      featured: { kind: 'page', id: devPageId },
    });
    expect(added.isError, JSON.stringify(added.payload)).toBe(false);
    expect(added.payload.occurrence_date).toBe(FIRST_OCCURRENCE);

    const [linked, ...others] = await occurrencesOf(owner, seriesId, WINDOW.start, WINDOW.end);
    expect(linked.occurrence_date).toBe(FIRST_OCCURRENCE);
    expect(linked.pages.map(p => p.id)).toEqual([devPageId]);
    expect(linked.assignments.map(a => a.assignment.id)).toEqual([devAssignmentId]);
    expect(linked.featured_resource).toMatchObject({ kind: 'page', id: devPageId });
    for (const other of others) {
      expect(other.pages).toEqual([]);
      expect(other.assignments).toEqual([]);
      expect(other.featured_resource).toBeNull();
    }

    // A student is shown the published page on that occurrence too.
    const [asStudent] = await occurrencesOf(student, seriesId, WINDOW.start, WINDOW.end);
    expect(asStudent.pages.map(p => p.id)).toEqual([devPageId]);

    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: devClassroomId,
      role: 'OWNER',
      resourceType: 'CALENDAR',
      action: 'UPDATE',
      resourceId: seriesId,
      tool: 'calendar_event_link_add',
      since: suiteStart,
    });
  });

  it('a date on the right UTC day at another time of day returns the real occurrence', async () => {
    // Accepted, as calendar_event_update accepts it — and answered with the
    // occurrence it landed on, not with the instant the caller made up.
    const guessed = await callTool(owner, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [devPageId],
      occurrence_date: '2027-03-02T20:00:00.000Z',
    });
    expect(guessed.isError, JSON.stringify(guessed.payload)).toBe(false);
    expect(guessed.payload.occurrence_date).toBe(FIRST_OCCURRENCE);
    expect(guessed.payload.start_time).toBe(FIRST_OCCURRENCE);
    // Rendered in the classroom's zone by the registry, as on the calendar reads.
    expect(typeof guessed.payload.start_time_local).toBe('string');
    expect(guessed.payload).not.toHaveProperty('occurrence_date_local');
    expect(guessed.payload.already_linked).toEqual({
      pages: [devPageId],
      slides: [],
      assignments: [],
    });

    const removed = await callTool(owner, 'calendar_event_link_remove', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [NOWHERE],
      occurrence_date: '2027-03-02T20:00:00.000Z',
    });
    expect(removed.isError, JSON.stringify(removed.payload)).toBe(false);
    expect(removed.payload.occurrence_date).toBe(FIRST_OCCURRENCE);
    expect(removed.payload.start_time).toBe(FIRST_OCCURRENCE);
  });

  it('a second occurrence takes its own links, and removing them leaves the first alone', async () => {
    const [first, second] = await occurrencesOf(owner, seriesId, WINDOW.start, WINDOW.end);

    const added = await callTool(owner, 'calendar_event_link_add', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [secondDevPageId],
      occurrence_date: second.occurrence_date,
    });
    expect(added.isError, JSON.stringify(added.payload)).toBe(false);
    expect(added.payload.links).toEqual({ pages: [secondDevPageId], slides: [], assignments: [] });

    const removed = await callTool(owner, 'calendar_event_link_remove', {
      classroom: DEV_REF,
      event_id: seriesId,
      page_ids: [secondDevPageId],
      occurrence_date: second.occurrence_date,
    });
    expect(removed.isError, JSON.stringify(removed.payload)).toBe(false);
    expect(removed.payload.links).toEqual({ pages: [], slides: [], assignments: [] });

    const [firstAfter, secondAfter] = await occurrencesOf(
      owner,
      seriesId,
      WINDOW.start,
      WINDOW.end
    );
    expect(firstAfter.occurrence_date).toBe(first.occurrence_date);
    expect(firstAfter.pages.map(p => p.id)).toEqual([devPageId]);
    expect(secondAfter.pages).toEqual([]);
  });
});

describe('calendar_event_create with links', () => {
  it('creates a one-off event with its links and star, and the read returns them', async () => {
    const since = new Date();
    const { eventId, payload } = await createEvent(teacher, {
      title: TITLES.createdWithLinks,
      event_type: 'LAB',
      start_time: '2027-03-03T10:00:00-05:00',
      end_time: '2027-03-03T11:00:00-05:00',
      page_ids: [devPageId, secondDevPageId],
      featured: { kind: 'page', id: secondDevPageId },
    });
    expect(payload.links).toEqual({
      pages: [devPageId, secondDevPageId],
      slides: [],
      assignments: [],
    });
    expect(payload.featured_resource).toEqual({ kind: 'page', id: secondDevPageId });

    const [row] = await occurrencesOf(teacher, eventId, '2027-03-02', '2027-03-04');
    expect(row.pages.map(p => p.id)).toEqual([devPageId, secondDevPageId]);
    expect(row.featured_resource).toMatchObject({ kind: 'page', id: secondDevPageId });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { resource_id: eventId, action: 'CREATE', timestamp: { gte: since } },
    });
    expect(audit.data).toMatchObject({
      tool: 'calendar_event_create',
      linked: { pages: [devPageId, secondDevPageId], slides: [], assignments: [] },
      featured: { kind: 'page', id: secondDevPageId },
    });
  });
});
