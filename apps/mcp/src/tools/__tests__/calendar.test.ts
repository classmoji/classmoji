/**
 * Unit tests for calendar_event_update recurrence preservation (finding U2).
 *
 * The service's 'all' branch derives recurrence_rule from is_recurring
 * (undefined → falsy → SQL NULL), and this tool has no recurrence inputs — so
 * a title-only 'all'-scope update used to NULL the rule while is_recurring
 * stayed true, collapsing the whole series to one occurrence on the next
 * expansion. The tool must carry the loaded event's is_recurring +
 * recurrence_rule through to updateEventWithScope unchanged.
 *
 * `@classmoji/services` is mocked (factory idiom); assertions pin the exact
 * updates object handed to the scoped service call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  getEventById: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  updateEventWithScope: vi.fn(),
  assertLinkTargetsInClassroom: vi.fn(),
  addEventLinks: vi.fn(),
  removeEventLinks: vi.fn(),
  auditCreate: vi.fn(),
  findByClassroomAndUser: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    calendar: {
      getEventById: (...a: unknown[]) => mocks.getEventById(...a),
      createEvent: (...a: unknown[]) => mocks.createEvent(...a),
      updateEvent: (...a: unknown[]) => mocks.updateEvent(...a),
      updateEventWithScope: (...a: unknown[]) => mocks.updateEventWithScope(...a),
      assertLinkTargetsInClassroom: (...a: unknown[]) => mocks.assertLinkTargetsInClassroom(...a),
      addEventLinks: (...a: unknown[]) => mocks.addEventLinks(...a),
      removeEventLinks: (...a: unknown[]) => mocks.removeEventLinks(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    // holdsRole falls back to this when the context's own role is not in the
    // list it was asked about.
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
  },
}));

// The write policy is NOT mocked: it is a dependency-free module, so these
// tests exercise the same decision the web calendar actions apply.
const { ASSISTANT_EVENT_TYPE_MESSAGE, CalendarLinkError } =
  await import('@classmoji/services/calendar-policy');

const {
  calendarEventCreateTool,
  calendarEventUpdateTool,
  calendarEventDeleteTool,
  calendarEventLinkAddTool,
  calendarEventLinkRemoveTool,
} = await import('../calendar.ts');
const { resourceLinkAddTool } = await import('../resourceLinks.ts');

/** OWNER context (skips the assistant own-events sub-gate cleanly). */
const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const RULE = { days: ['monday', 'wednesday'], until: '2026-08-31T00:00:00.000Z' };

const RECURRING_EVENT = {
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  title: 'Lecture',
  is_recurring: true,
  recurrence_rule: RULE,
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** An ASSISTANT holding no other role in this classroom. */
const ASSISTANT_CTX: ToolContext = {
  viewer: { userId: 'ta-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'ASSISTANT',
    status: 'ACTIVE',
    membership: { id: 'm-2', role: 'ASSISTANT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

/** That assistant's own office-hours event. */
const OWN_OFFICE_HOURS = {
  id: 'event-3',
  classroom_id: 'class-1',
  created_by: 'ta-1',
  title: 'Office hours',
  event_type: 'OFFICE_HOURS',
  is_recurring: false,
  recurrence_rule: null,
  start_time: new Date('2026-07-20T10:00:00-04:00'),
  end_time: new Date('2026-07-20T11:00:00-04:00'),
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getEventById.mockResolvedValue(RECURRING_EVENT);
  mocks.updateEventWithScope.mockResolvedValue(RECURRING_EVENT);
  mocks.auditCreate.mockResolvedValue(undefined);
  // No second membership unless a test says otherwise.
  mocks.findByClassroomAndUser.mockResolvedValue(null);
});

// ─── F5: end_time must be after start_time ──────────────────────────────────

/** Non-recurring event with concrete Date bounds (for single-edge update). */
const TIMED_EVENT = {
  id: 'event-2',
  classroom_id: 'class-1',
  created_by: 'owner-1',
  title: 'Office Hours',
  is_recurring: false,
  recurrence_rule: null,
  start_time: new Date('2026-07-20T10:00:00-04:00'),
  end_time: new Date('2026-07-20T11:00:00-04:00'),
};

const CREATE_BASE = {
  classroom: 'org/winter-2025',
  title: 'Lab',
  event_type: 'LAB' as const,
};

async function expectInvalidParams(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ kind: 'invalid_params' });
}

describe('calendar end_time > start_time (F5)', () => {
  it('rejects create when end_time <= start_time (before createEvent)', async () => {
    await expectInvalidParams(
      calendarEventCreateTool.handler(
        {
          ...CREATE_BASE,
          start_time: '2026-07-20T11:00:00-04:00',
          end_time: '2026-07-20T10:00:00-04:00',
        },
        CTX
      )
    );
    // Zero-length range also rejected (strict >).
    await expectInvalidParams(
      calendarEventCreateTool.handler(
        {
          ...CREATE_BASE,
          start_time: '2026-07-20T10:00:00-04:00',
          end_time: '2026-07-20T10:00:00-04:00',
        },
        CTX
      )
    );
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('allows a valid create', async () => {
    mocks.createEvent.mockResolvedValue({
      ...TIMED_EVENT,
      event_type: 'LAB',
    });
    await calendarEventCreateTool.handler(
      {
        ...CREATE_BASE,
        start_time: '2026-07-20T10:00:00-04:00',
        end_time: '2026-07-20T11:00:00-04:00',
      },
      CTX
    );
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a single-edge update that inverts against the stored bound', async () => {
    mocks.getEventById.mockResolvedValue(TIMED_EVENT);
    // Move only start_time to AFTER the stored end (11:00) → invalid.
    await expectInvalidParams(
      calendarEventUpdateTool.handler(
        {
          classroom: 'org/winter-2025',
          event_id: 'event-2',
          start_time: '2026-07-20T12:00:00-04:00',
        },
        CTX
      )
    );
    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  it('allows a valid single-edge update (extend the end)', async () => {
    mocks.getEventById.mockResolvedValue(TIMED_EVENT);
    mocks.updateEvent.mockResolvedValue(TIMED_EVENT);
    await calendarEventUpdateTool.handler(
      { classroom: 'org/winter-2025', event_id: 'event-2', end_time: '2026-07-20T12:30:00-04:00' },
      CTX
    );
    expect(mocks.updateEvent).toHaveBeenCalledTimes(1);
  });

  it('does NOT reject a recurring single-edge (this_only) override vs the template bound', async () => {
    // RECURRING_EVENT's stored bounds are the SERIES TEMPLATE's absolute
    // datetimes, not the edited occurrence's — a start-only override must not be
    // validated against them (that was the false-rejection bug). getEventById
    // defaults to RECURRING_EVENT.
    await calendarEventUpdateTool.handler(
      {
        classroom: 'org/winter-2025',
        event_id: 'event-1',
        start_time: '2026-02-02T12:00:00-04:00',
        edit_scope: 'this_only',
        occurrence_date: '2026-02-02T10:00:00-04:00',
      },
      CTX
    );
    expect(mocks.updateEventWithScope).toHaveBeenCalledTimes(1);
  });

  it('still validates both-edges override on a recurring event', async () => {
    await expectInvalidParams(
      calendarEventUpdateTool.handler(
        {
          classroom: 'org/winter-2025',
          event_id: 'event-1',
          start_time: '2026-02-02T12:00:00-04:00',
          end_time: '2026-02-02T11:00:00-04:00',
          edit_scope: 'this_only',
          occurrence_date: '2026-02-02T10:00:00-04:00',
        },
        CTX
      )
    );
    expect(mocks.updateEventWithScope).not.toHaveBeenCalled();
  });
});

describe('calendar_event_update recurrence preservation (U2)', () => {
  it("carries is_recurring + recurrence_rule into an 'all'-scope title-only update", async () => {
    const result = await calendarEventUpdateTool.handler(
      {
        classroom: 'org/winter-2025',
        event_id: 'event-1',
        title: 'Renamed Lecture',
        edit_scope: 'all',
        occurrence_date: '2026-07-20T10:00:00-04:00',
      },
      CTX
    );

    expect(mocks.updateEventWithScope).toHaveBeenCalledTimes(1);
    const [eventId, updates, scope] = mocks.updateEventWithScope.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
      Date,
    ];
    expect(eventId).toBe('event-1');
    expect(scope).toBe('all');
    // The whole point of U2: the series definition survives a partial update.
    expect(updates.is_recurring).toBe(true);
    expect(updates.recurrence_rule).toEqual(RULE);
    expect(updates.title).toBe('Renamed Lecture');

    // The caller-facing report still lists only the fields THEY changed.
    expect(parse(result).updated_fields).toEqual(['title']);
  });

  it("passes 'this_only' updates through without recurrence fields (occurrence override)", async () => {
    await calendarEventUpdateTool.handler(
      {
        classroom: 'org/winter-2025',
        event_id: 'event-1',
        location: 'Room 42',
        edit_scope: 'this_only',
        occurrence_date: '2026-07-20T10:00:00-04:00',
      },
      CTX
    );

    expect(mocks.updateEventWithScope).toHaveBeenCalledTimes(1);
    const updates = mocks.updateEventWithScope.mock.calls[0][1] as Record<string, unknown>;
    expect(updates).toEqual({ location: 'Room 42' });
  });
});

// ─── The office-hours limit on assistants ───────────────────────────────────

/**
 * The same policy both web calendar actions apply, enforced here too: this
 * server is a third way in, and a limit that only one of three doors checks is
 * not a limit. The decision itself is pinned in
 * packages/services/…/calendarPolicy.test.ts.
 */
describe('assistants and event types', () => {
  it('refuses an assistant creating anything but office hours', async () => {
    await expect(
      calendarEventCreateTool.handler(
        {
          ...CREATE_BASE,
          start_time: '2026-07-20T10:00:00-04:00',
          end_time: '2026-07-20T11:00:00-04:00',
        },
        ASSISTANT_CTX
      )
    ).rejects.toMatchObject({ kind: 'forbidden', message: ASSISTANT_EVENT_TYPE_MESSAGE });

    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('lets an assistant create office hours', async () => {
    mocks.createEvent.mockResolvedValue(OWN_OFFICE_HOURS);

    await calendarEventCreateTool.handler(
      {
        ...CREATE_BASE,
        event_type: 'OFFICE_HOURS',
        start_time: '2026-07-20T10:00:00-04:00',
        end_time: '2026-07-20T11:00:00-04:00',
      },
      ASSISTANT_CTX
    );

    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses an assistant retyping their office hours', async () => {
    mocks.getEventById.mockResolvedValue(OWN_OFFICE_HOURS);

    await expect(
      calendarEventUpdateTool.handler(
        { classroom: 'org/winter-2025', event_id: OWN_OFFICE_HOURS.id, event_type: 'LECTURE' },
        ASSISTANT_CTX
      )
    ).rejects.toMatchObject({ kind: 'forbidden', message: ASSISTANT_EVENT_TYPE_MESSAGE });

    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  it('lets an assistant edit their office hours without touching the type', async () => {
    mocks.getEventById.mockResolvedValue(OWN_OFFICE_HOURS);

    await calendarEventUpdateTool.handler(
      { classroom: 'org/winter-2025', event_id: OWN_OFFICE_HOURS.id, location: 'ECSC 004' },
      ASSISTANT_CTX
    );

    expect(mocks.updateEvent).toHaveBeenCalledTimes(1);
  });

  it('does not limit an OWNER', async () => {
    mocks.getEventById.mockResolvedValue({ ...OWN_OFFICE_HOURS, created_by: 'owner-1' });

    await calendarEventUpdateTool.handler(
      { classroom: 'org/winter-2025', event_id: OWN_OFFICE_HOURS.id, event_type: 'LECTURE' },
      CTX
    );

    expect(mocks.updateEvent).toHaveBeenCalledTimes(1);
  });

  it('does not limit someone who ALSO holds a teacher membership', async () => {
    // holdsRole, not the context's resolved role: a multi-role user whose gate
    // happened to resolve as ASSISTANT is not an assistant for this purpose.
    mocks.getEventById.mockResolvedValue(OWN_OFFICE_HOURS);
    mocks.findByClassroomAndUser.mockResolvedValue({ id: 'm-9', role: 'TEACHER' });

    await calendarEventUpdateTool.handler(
      { classroom: 'org/winter-2025', event_id: OWN_OFFICE_HOURS.id, event_type: 'LECTURE' },
      ASSISTANT_CTX
    );

    expect(mocks.updateEvent).toHaveBeenCalledTimes(1);
  });
});

// ─── A split reports the event the edit landed on ───────────────────────────

describe('calendar_event_update after a this_and_future split', () => {
  it('returns and audits the NEW event, not the id it was called with', async () => {
    // That scope ends the old series and moves the occurrences from this date
    // on to a new event. Reporting the old id would file the audit against a
    // series that no longer covers the date, and hand the caller an id whose
    // event does not carry their change.
    mocks.updateEventWithScope.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-new' });

    const result = await calendarEventUpdateTool.handler(
      {
        classroom: 'org/winter-2025',
        event_id: 'event-1',
        title: 'Moved',
        edit_scope: 'this_and_future',
        occurrence_date: '2026-07-20T00:00:00-04:00',
      },
      CTX
    );

    expect(parse(result as { content: Array<{ text: string }> })).toMatchObject({
      success: true,
      event_id: 'event-new',
    });

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      resource_id: string;
      data: Record<string, unknown>;
    };
    expect(audit.resource_id).toBe('event-new');
    // The row the request named is still recorded, so the two can be tied up.
    expect(audit.data.split_from_event_id).toBe('event-1');
  });

  it('keeps reporting the same id when no split happened', async () => {
    mocks.updateEventWithScope.mockResolvedValue(RECURRING_EVENT);

    const result = await calendarEventUpdateTool.handler(
      {
        classroom: 'org/winter-2025',
        event_id: 'event-1',
        title: 'Renamed',
        edit_scope: 'all',
        occurrence_date: '2026-07-20T00:00:00-04:00',
      },
      CTX
    );

    expect(parse(result as { content: Array<{ text: string }> }).event_id).toBe('event-1');
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).not.toHaveProperty('split_from_event_id');
  });
});

// ─── Linked content ─────────────────────────────────────────────────────────

const NO_IDS = { pageIds: [], slideIds: [], assignmentIds: [] };

/** The occurrence of an event that has one date: no occurrence date, its own start. */
const ONE_DATE = { occurrence_date: null, start_time: new Date('2026-07-20T14:00:00.000Z') };

/** One occurrence of a series, as the service reports the one it matched. */
const occurrenceAt = (iso: string) => ({
  occurrence_date: new Date(iso),
  start_time: new Date(iso),
});

/** What the service answers for a call that added one page to an empty date. */
const ADDED_ONE_PAGE = {
  added: { ...NO_IDS, pageIds: ['p-1'] },
  alreadyLinked: NO_IDS,
  occurrence: ONE_DATE,
  links: { ...NO_IDS, pageIds: ['p-1'] },
  featured: null,
};

const lastAudit = () =>
  mocks.auditCreate.mock.calls.at(-1)?.[0] as {
    resource_type: string;
    resource_id: string;
    action: string;
    data: Record<string, unknown>;
  };

describe('calendar_event_create with links', () => {
  const ONE_OFF = {
    classroom: 'org/winter-2025',
    title: 'Lab',
    event_type: 'LAB' as const,
    start_time: '2026-07-20T10:00:00-04:00',
    end_time: '2026-07-20T11:00:00-04:00',
  };

  beforeEach(() => {
    mocks.createEvent.mockResolvedValue({ ...TIMED_EVENT, event_type: 'LAB' });
    mocks.assertLinkTargetsInClassroom.mockResolvedValue(undefined);
    mocks.addEventLinks.mockResolvedValue(ADDED_ONE_PAGE);
  });

  it('refuses links on a recurring event before it creates anything', async () => {
    // A series has no date to hang them on: they would be saved to a bucket
    // none of its occurrences reads.
    await expect(
      calendarEventCreateTool.handler(
        { ...ONE_OFF, is_recurring: true, recurrence_rule: RULE, page_ids: ['p-1'] },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('calendar_event_link_add'),
    });

    expect(mocks.assertLinkTargetsInClassroom).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('checks the ids before the event exists, so a bad one leaves no event behind', async () => {
    mocks.assertLinkTargetsInClassroom.mockRejectedValue(
      new CalendarLinkError('targets_not_found', 'x', { ...NO_IDS, pageIds: ['p-foreign'] })
    );

    await expect(
      calendarEventCreateTool.handler({ ...ONE_OFF, page_ids: ['p-foreign'] }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });

    expect(mocks.assertLinkTargetsInClassroom).toHaveBeenCalledWith(
      'class-1',
      { ...NO_IDS, pageIds: ['p-foreign'] },
      null
    );
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.addEventLinks).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('links them to the new event, undated, and reports and audits what was linked', async () => {
    const featured = { kind: 'page' as const, id: 'p-1' };
    mocks.addEventLinks.mockResolvedValue({ ...ADDED_ONE_PAGE, featured });

    const result = await calendarEventCreateTool.handler(
      { ...ONE_OFF, page_ids: ['p-1'], featured },
      CTX
    );

    expect(mocks.assertLinkTargetsInClassroom.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createEvent.mock.invocationCallOrder[0]
    );
    expect(mocks.addEventLinks).toHaveBeenCalledWith(
      'event-2',
      'class-1',
      { ...NO_IDS, pageIds: ['p-1'] },
      null,
      featured
    );
    expect(parse(result)).toMatchObject({
      success: true,
      event: { id: 'event-2' },
      links: { pages: ['p-1'], slides: [], assignments: [] },
      featured_resource: featured,
    });
    expect(lastAudit()).toMatchObject({
      action: 'CREATE',
      resource_id: 'event-2',
      data: {
        tool: 'calendar_event_create',
        linked: { pages: ['p-1'], slides: [], assignments: [] },
        featured,
      },
    });
  });

  it('says the event WAS created, and hands over its id, when the links are refused after it', async () => {
    // Only reachable if a resource changed between the check and the write. A
    // bare refusal would read as "nothing happened" and invite a second event.
    mocks.addEventLinks.mockRejectedValue(
      new CalendarLinkError('targets_not_found', 'x', { ...NO_IDS, pageIds: ['p-1'] })
    );

    await expect(
      calendarEventCreateTool.handler({ ...ONE_OFF, page_ids: ['p-1'] }, CTX)
    ).rejects.toMatchObject({
      kind: 'not_found',
      code: 'EVENT_CREATED_LINKS_NOT_SAVED',
      message:
        'The event WAS created (event_id event-2), but its links were not saved: Page not found ' +
        'in this classroom. Do not create it again — attach the links to this event with ' +
        'calendar_event_link_add.',
      data: { event_id: 'event-2', not_found: { pages: ['p-1'], slides: [], assignments: [] } },
    });

    // The event is committed by then, so its audit row is not skipped.
    expect(lastAudit()).toMatchObject({
      action: 'CREATE',
      resource_id: 'event-2',
      data: { tool: 'calendar_event_create', title: 'Lab' },
    });
    expect(lastAudit().data).not.toHaveProperty('linked');
  });

  it('says the same when the link write fails on a fault, not a refusal', async () => {
    // Left to the registry this would be a bare "Internal server error", with
    // the event already on the calendar and nothing telling the caller so.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fault = new Error('connection reset');
    mocks.addEventLinks.mockRejectedValue(fault);

    await expect(
      calendarEventCreateTool.handler({ ...ONE_OFF, page_ids: ['p-1'] }, CTX)
    ).rejects.toMatchObject({
      name: 'ToolError',
      kind: 'internal',
      code: 'EVENT_CREATED_LINKS_NOT_SAVED',
      message:
        'The event WAS created (event_id event-2), but its links were not saved. Do not create ' +
        'it again — attach the links to this event with calendar_event_link_add.',
      data: { event_id: 'event-2' },
    });

    // The fault itself stays server-side, where the registry would have put it.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('calendar_event_create'), fault);
    expect(lastAudit()).toMatchObject({ action: 'CREATE', resource_id: 'event-2' });
    logged.mockRestore();
  });

  it('touches no link code for an event created without any', async () => {
    const result = await calendarEventCreateTool.handler(ONE_OFF, CTX);

    expect(mocks.assertLinkTargetsInClassroom).not.toHaveBeenCalled();
    expect(mocks.addEventLinks).not.toHaveBeenCalled();
    expect(parse(result)).toMatchObject({
      links: { pages: [], slides: [], assignments: [] },
      featured_resource: null,
    });
    expect(lastAudit().data).toEqual({ tool: 'calendar_event_create', title: 'Lab' });
  });
});

describe('calendar_event_link_add', () => {
  const ARGS = { classroom: 'org/winter-2025', event_id: 'event-2', page_ids: ['p-1'] };

  beforeEach(() => {
    mocks.getEventById.mockResolvedValue(TIMED_EVENT);
    mocks.addEventLinks.mockResolvedValue(ADDED_ONE_PAGE);
  });

  it('needs at least one id', async () => {
    await expectInvalidParams(
      calendarEventLinkAddTool.handler({ classroom: 'org/winter-2025', event_id: 'event-2' }, CTX)
    );
    await expectInvalidParams(
      calendarEventLinkAddTool.handler({ ...ARGS, page_ids: [], slide_ids: [] }, CTX)
    );
    expect(mocks.addEventLinks).not.toHaveBeenCalled();
  });

  it('holds an assistant to events they created, as an update does', async () => {
    // TIMED_EVENT was created by owner-1.
    await expect(calendarEventLinkAddTool.handler(ARGS, ASSISTANT_CTX)).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'INSUFFICIENT_ROLE',
    });
    expect(mocks.addEventLinks).not.toHaveBeenCalled();

    mocks.getEventById.mockResolvedValue(OWN_OFFICE_HOURS);
    await calendarEventLinkAddTool.handler(
      { ...ARGS, event_id: OWN_OFFICE_HOURS.id },
      ASSISTANT_CTX
    );
    expect(mocks.addEventLinks).toHaveBeenCalledTimes(1);
  });

  it('refuses an event from another classroom without asking the service', async () => {
    mocks.getEventById.mockResolvedValue({ ...TIMED_EVENT, classroom_id: 'class-other' });

    await expect(calendarEventLinkAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.addEventLinks).not.toHaveBeenCalled();
  });

  it('hands the service the authorized classroom, the ids, the occurrence and the star', async () => {
    mocks.getEventById.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-1' });
    const featured = { kind: 'slide' as const, id: 's-1' };

    await calendarEventLinkAddTool.handler(
      {
        classroom: 'org/winter-2025',
        event_id: 'event-1',
        slide_ids: ['s-1'],
        assignment_ids: ['a-1'],
        occurrence_date: '2026-07-21T00:30:00.000Z',
        featured,
      },
      CTX
    );

    expect(mocks.addEventLinks).toHaveBeenCalledWith(
      'event-1',
      'class-1',
      { pageIds: [], slideIds: ['s-1'], assignmentIds: ['a-1'] },
      new Date('2026-07-21T00:30:00.000Z'),
      featured
    );
  });

  it('names the kinds as the calendar reads do', async () => {
    mocks.addEventLinks.mockResolvedValue({
      added: { ...NO_IDS, pageIds: ['p-1'] },
      alreadyLinked: { ...NO_IDS, slideIds: ['s-1'] },
      occurrence: ONE_DATE,
      links: { pageIds: ['p-0', 'p-1'], slideIds: ['s-1'], assignmentIds: ['a-1'] },
      featured: { kind: 'slide', id: 's-1' },
    });

    const result = await calendarEventLinkAddTool.handler({ ...ARGS, slide_ids: ['s-1'] }, CTX);

    expect(parse(result)).toEqual({
      success: true,
      event_id: 'event-2',
      occurrence_date: null,
      start_time: '2026-07-20T14:00:00.000Z',
      added: { pages: ['p-1'], slides: [], assignments: [] },
      already_linked: { pages: [], slides: ['s-1'], assignments: [] },
      links: { pages: ['p-0', 'p-1'], slides: ['s-1'], assignments: ['a-1'] },
      featured_resource: { kind: 'slide', id: 's-1' },
    });
  });

  it.each([
    ['occurrence_required', 'invalid_params', 'occurrence_date'],
    ['occurrence_not_allowed', 'invalid_params', 'omit it'],
    ['not_an_occurrence', 'invalid_params', 'UTC instant'],
    ['featured_not_linked', 'invalid_params', 'featured must name'],
    ['quizzes_hidden', 'forbidden', 'Quizzes are not available'],
    ['event_not_found', 'not_found', 'Calendar event not found in this classroom'],
  ] as const)('maps the service refusal %s to %s', async (reason, kind, says) => {
    mocks.addEventLinks.mockRejectedValue(new CalendarLinkError(reason, 'service wording'));

    await expect(calendarEventLinkAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind,
      message: expect.stringContaining(says),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports ids from another classroom as not found, naming only what the caller sent', async () => {
    mocks.addEventLinks.mockRejectedValue(
      new CalendarLinkError('targets_not_found', 'x', {
        pageIds: ['p-foreign'],
        slideIds: [],
        assignmentIds: [],
      })
    );

    await expect(calendarEventLinkAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Page not found in this classroom',
      data: { not_found: { pages: ['p-foreign'], slides: [], assignments: [] } },
    });
  });

  it('recognises a refusal that lost its class identity on the way', async () => {
    mocks.addEventLinks.mockRejectedValue({ reason: 'occurrence_required', message: 'x' });

    await expectInvalidParams(calendarEventLinkAddTool.handler(ARGS, CTX));
  });

  it('leaves a real fault alone, for the registry to report as internal', async () => {
    const fault = new Error('connection reset');
    mocks.addEventLinks.mockRejectedValue(fault);

    await expect(calendarEventLinkAddTool.handler(ARGS, CTX)).rejects.toBe(fault);
  });

  it('returns the occurrence the service matched, not the date it was handed', async () => {
    // Any instant on the occurrence's UTC day is accepted; the answer says
    // which occurrence that was, under the key the zone rendering picks up.
    mocks.getEventById.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-1' });
    mocks.addEventLinks.mockResolvedValue({
      ...ADDED_ONE_PAGE,
      occurrence: occurrenceAt('2026-07-20T14:00:00.000Z'),
    });

    const result = await calendarEventLinkAddTool.handler(
      { ...ARGS, event_id: 'event-1', occurrence_date: '2026-07-20T03:00:00.000Z' },
      CTX
    );

    expect(parse(result)).toMatchObject({
      occurrence_date: '2026-07-20T14:00:00.000Z',
      start_time: '2026-07-20T14:00:00.000Z',
    });
    expect(lastAudit().data.occurrence_date).toBe('2026-07-20T14:00:00.000Z');
  });

  it('audits the ids, the occurrence and the star', async () => {
    mocks.getEventById.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-1' });
    mocks.addEventLinks.mockResolvedValue({
      ...ADDED_ONE_PAGE,
      alreadyLinked: { ...NO_IDS, slideIds: ['s-1'] },
      occurrence: occurrenceAt('2026-07-20T14:00:00.000Z'),
    });
    const featured = { kind: 'page' as const, id: 'p-1' };

    await calendarEventLinkAddTool.handler(
      {
        ...ARGS,
        event_id: 'event-1',
        slide_ids: ['s-1'],
        occurrence_date: '2026-07-20T14:00:00.000Z',
        featured,
      },
      CTX
    );

    expect(lastAudit()).toMatchObject({
      resource_type: 'CALENDAR',
      resource_id: 'event-1',
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_link_add',
        added: { pages: ['p-1'], slides: [], assignments: [] },
        already_linked: { pages: [], slides: ['s-1'], assignments: [] },
        occurrence_date: '2026-07-20T14:00:00.000Z',
        featured,
      },
    });
  });

  it('gives two occurrences of one event different audit values, so neither is coalesced', async () => {
    mocks.getEventById.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-1' });

    for (const occurrence_date of ['2026-07-20T14:00:00.000Z', '2026-07-27T14:00:00.000Z']) {
      mocks.addEventLinks.mockResolvedValue({
        ...ADDED_ONE_PAGE,
        occurrence: occurrenceAt(occurrence_date),
      });
      await calendarEventLinkAddTool.handler(
        { ...ARGS, event_id: 'event-1', occurrence_date },
        CTX
      );
    }

    const [first, second] = mocks.auditCreate.mock.calls.map(
      call => (call[0] as { data: { value: string } }).data.value
    );
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it('audits a repeat that changed nothing, as every other call', async () => {
    mocks.addEventLinks.mockResolvedValue({
      added: NO_IDS,
      alreadyLinked: { ...NO_IDS, pageIds: ['p-1'] },
      occurrence: ONE_DATE,
      links: { ...NO_IDS, pageIds: ['p-1'] },
      featured: null,
    });

    await calendarEventLinkAddTool.handler(ARGS, CTX);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(lastAudit().data).toMatchObject({
      tool: 'calendar_event_link_add',
      added: { pages: [], slides: [], assignments: [] },
      already_linked: { pages: ['p-1'], slides: [], assignments: [] },
    });
  });
});

describe('calendar_event_link_remove', () => {
  const ARGS = { classroom: 'org/winter-2025', event_id: 'event-2', page_ids: ['p-1', 'p-9'] };

  beforeEach(() => {
    mocks.getEventById.mockResolvedValue(TIMED_EVENT);
    mocks.removeEventLinks.mockResolvedValue({
      removed: { ...NO_IDS, pageIds: ['p-1'] },
      notLinked: { ...NO_IDS, pageIds: ['p-9'] },
      occurrence: occurrenceAt('2026-07-20T14:00:00.000Z'),
      links: { ...NO_IDS, slideIds: ['s-1'] },
      featured: null,
    });
  });

  it('needs at least one id, and the same gate as an update', async () => {
    await expectInvalidParams(
      calendarEventLinkRemoveTool.handler(
        { classroom: 'org/winter-2025', event_id: 'event-2' },
        CTX
      )
    );
    await expect(calendarEventLinkRemoveTool.handler(ARGS, ASSISTANT_CTX)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.removeEventLinks).not.toHaveBeenCalled();
  });

  it('removes on the named occurrence and reports what was and was not linked', async () => {
    mocks.getEventById.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-1' });

    const result = await calendarEventLinkRemoveTool.handler(
      { ...ARGS, event_id: 'event-1', occurrence_date: '2026-07-20T14:00:00.000Z' },
      CTX
    );

    expect(mocks.removeEventLinks).toHaveBeenCalledWith(
      'event-1',
      'class-1',
      { ...NO_IDS, pageIds: ['p-1', 'p-9'] },
      new Date('2026-07-20T14:00:00.000Z')
    );
    expect(parse(result)).toEqual({
      success: true,
      event_id: 'event-1',
      occurrence_date: '2026-07-20T14:00:00.000Z',
      start_time: '2026-07-20T14:00:00.000Z',
      removed: { pages: ['p-1'], slides: [], assignments: [] },
      not_linked: { pages: ['p-9'], slides: [], assignments: [] },
      links: { pages: [], slides: ['s-1'], assignments: [] },
      featured_resource: null,
    });
    expect(lastAudit()).toMatchObject({
      resource_type: 'CALENDAR',
      resource_id: 'event-1',
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_link_remove',
        removed: { pages: ['p-1'], slides: [], assignments: [] },
        not_linked: { pages: ['p-9'], slides: [], assignments: [] },
        occurrence_date: '2026-07-20T14:00:00.000Z',
      },
    });
  });

  it('returns the date and no start for a date the series no longer falls on', async () => {
    mocks.getEventById.mockResolvedValue({ ...RECURRING_EVENT, id: 'event-1' });
    mocks.removeEventLinks.mockResolvedValue({
      removed: { ...NO_IDS, pageIds: ['p-1'] },
      notLinked: NO_IDS,
      occurrence: { occurrence_date: new Date('2026-07-20T00:00:00.000Z'), start_time: null },
      links: NO_IDS,
      featured: null,
    });

    const result = await calendarEventLinkRemoveTool.handler(
      { ...ARGS, event_id: 'event-1', occurrence_date: '2026-07-20T14:00:00.000Z' },
      CTX
    );

    expect(parse(result)).toMatchObject({
      occurrence_date: '2026-07-20T00:00:00.000Z',
      start_time: null,
    });
  });

  it('maps a missing occurrence_date the way add does', async () => {
    mocks.removeEventLinks.mockRejectedValue(new CalendarLinkError('occurrence_required', 'x'));

    await expectInvalidParams(calendarEventLinkRemoveTool.handler(ARGS, CTX));
  });

  it('audits a call that removed nothing, as every other call', async () => {
    mocks.removeEventLinks.mockResolvedValue({
      removed: NO_IDS,
      notLinked: { ...NO_IDS, pageIds: ['p-1', 'p-9'] },
      occurrence: ONE_DATE,
      links: NO_IDS,
      featured: null,
    });

    await calendarEventLinkRemoveTool.handler(ARGS, CTX);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(lastAudit().data).toMatchObject({
      tool: 'calendar_event_link_remove',
      removed: { pages: [], slides: [], assignments: [] },
      not_linked: { pages: ['p-1', 'p-9'], slides: [], assignments: [] },
    });
  });
});

describe('calendar tool definitions', () => {
  const tools = [
    calendarEventCreateTool,
    calendarEventUpdateTool,
    calendarEventDeleteTool,
    calendarEventLinkAddTool,
    calendarEventLinkRemoveTool,
  ];

  it('keep descriptions under the 1,500 bytes a client will keep', () => {
    // resource_link_add too: its description names calendar_event_link_add, so
    // the two are edited together.
    for (const tool of [...tools, resourceLinkAddTool]) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
    expect(resourceLinkAddTool.description).toContain('calendar_event_link_add');
  });

  it('gives the link tools the gate the other calendar writes have', () => {
    for (const tool of [calendarEventLinkAddTool, calendarEventLinkRemoveTool]) {
      expect(tool.scope).toBe('write');
      expect(tool.roles).toEqual(calendarEventUpdateTool.roles);
      expect(tool.inputSchema).toHaveProperty('classroom');
    }
  });

  it('marks unlinking destructive, as the other unlink tools are, and both repeatable', () => {
    expect(calendarEventLinkAddTool.annotations).toEqual({ destructive: false, idempotent: true });
    expect(calendarEventLinkRemoveTool.annotations).toEqual({
      destructive: true,
      idempotent: true,
    });
  });

  it('bounds each id list and takes the star as kind + id', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `p-${i}`);
    for (const tool of [calendarEventCreateTool, calendarEventLinkAddTool]) {
      const pageIds = tool.inputSchema.page_ids as ZodTypeAny;
      expect(pageIds.safeParse(ids).success).toBe(false);
      expect(pageIds.safeParse(ids.slice(0, 20)).success).toBe(true);

      const featured = tool.inputSchema.featured as ZodTypeAny;
      expect(featured.safeParse({ kind: 'slide', id: 's-1' }).success).toBe(true);
      expect(featured.safeParse({ kind: 'quiz', id: 'q-1' }).success).toBe(false);
    }
    expect(calendarEventLinkRemoveTool.inputSchema).not.toHaveProperty('featured');
  });
});
