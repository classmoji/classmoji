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
 *
 * Also covers calendar_event_links_set: the occurrence-date rules, the
 * classroom check on every newly linked id, the merge of omitted kinds with the
 * date's current links, and the star rules, pinned on the exact arguments
 * handed to updateEventLinks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  getEventById: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  updateEventWithScope: vi.fn(),
  auditCreate: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  getClassroomCalendar: vi.fn(),
  updateEventLinks: vi.fn(),
  pageFindById: vi.fn(),
  slideFindById: vi.fn(),
  assignmentFindById: vi.fn(),
  quizzesVisible: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    calendar: {
      getEventById: (...a: unknown[]) => mocks.getEventById(...a),
      createEvent: (...a: unknown[]) => mocks.createEvent(...a),
      updateEvent: (...a: unknown[]) => mocks.updateEvent(...a),
      updateEventWithScope: (...a: unknown[]) => mocks.updateEventWithScope(...a),
      getClassroomCalendar: (...a: unknown[]) => mocks.getClassroomCalendar(...a),
      updateEventLinks: (...a: unknown[]) => mocks.updateEventLinks(...a),
    },
    page: { findById: (...a: unknown[]) => mocks.pageFindById(...a) },
    assignment: { findById: (...a: unknown[]) => mocks.assignmentFindById(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    // holdsRole falls back to this when the context's own role is not in the
    // list it was asked about.
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
  },
}));

// shared.ts loads decks through this module, not through ClassmojiService.
vi.mock('@classmoji/services/slides', () => ({
  slideService: { findById: (...a: unknown[]) => mocks.slideFindById(...a) },
}));

// The write policy is NOT mocked: it is a dependency-free module, so these
// tests exercise the same decision the web calendar actions apply.
const { ASSISTANT_EVENT_TYPE_MESSAGE, MEETING_LINK_MESSAGE } =
  await import('@classmoji/services/calendar-policy');

const { calendarEventCreateTool, calendarEventLinksSetTool, calendarEventUpdateTool } =
  await import('../calendar.ts');

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

// ─── meeting_link is one http(s) URL ────────────────────────────────────────

describe('meeting_link validation', () => {
  const ZOOM = 'https://school.zoom.us/j/91234567890?pwd=abc';
  const tools = [
    {
      name: 'calendar_event_create',
      schema: z.object(calendarEventCreateTool.inputSchema),
      base: {
        ...CREATE_BASE,
        start_time: '2026-07-20T10:00:00-04:00',
        end_time: '2026-07-20T11:00:00-04:00',
      },
    },
    {
      name: 'calendar_event_update',
      schema: z.object(calendarEventUpdateTool.inputSchema),
      base: { classroom: 'org/winter-2025', event_id: '00000000-0000-4000-8000-000000000001' },
    },
  ];

  it.each(tools)('$name accepts an http(s) link', ({ schema, base }) => {
    expect(schema.safeParse({ ...base, meeting_link: ZOOM }).success).toBe(true);
    expect(schema.safeParse({ ...base, meeting_link: 'http://example.edu/room' }).success).toBe(
      true
    );
  });

  it.each(tools)('$name refuses anything else', ({ schema, base }) => {
    for (const meeting_link of [
      `Join Zoom Meeting ${ZOOM} Meeting ID: 912 3456 7890`,
      // `.url()` alone lets these through: the parser encodes the spaces, and
      // it accepts any scheme.
      `${ZOOM} Meeting ID: 912 3456 7890`,
      'javascript:alert(1)',
      'mailto:ta@example.edu',
      'ftp://files.example.edu/x',
      'zoom.us/j/1',
    ]) {
      const result = schema.safeParse({ ...base, meeting_link });
      expect(result.success, meeting_link).toBe(false);
    }
  });

  it.each(tools)('$name says what to enter', ({ schema, base }) => {
    const result = schema.safeParse({ ...base, meeting_link: 'mailto:ta@example.edu' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(i => i.message)).toContain(MEETING_LINK_MESSAGE);
  });

  it.each([calendarEventCreateTool, calendarEventUpdateTool])(
    '$name keeps the url check, which publishes the field as format uri',
    tool => {
      const field = tool.inputSchema.meeting_link as z.ZodOptional<z.ZodEffects<z.ZodString>>;
      expect(field.unwrap().innerType().isURL).toBe(true);
    }
  );
});

// ─── calendar_event_links_set ────────────────────────────────────────────────

describe('calendar_event_links_set', () => {
  /** A Tue/Thu lecture series starting 10:00 EDT (14:00Z). */
  const SERIES = {
    id: 'series-1',
    classroom_id: 'class-1',
    created_by: 'owner-1',
    title: 'Lecture',
    event_type: 'LECTURE',
    is_recurring: true,
    recurrence_rule: { days: ['tuesday', 'thursday'] },
    start_time: new Date('2026-09-15T14:00:00.000Z'),
    end_time: new Date('2026-09-15T15:15:00.000Z'),
  };
  /** The occurrence as list_calendar returns it: the series start's time of day. */
  const OCCURRENCE = '2026-10-13T14:00:00.000Z';
  const BUCKET = new Date('2026-10-13T00:00:00.000Z');
  const OTHER_BUCKET = new Date('2026-10-15T00:00:00.000Z');

  /**
   * The 13th: page-a, then deck-a starred. Raw rows also carry the 15th's links
   * (the raw arrays span every date), which must never be carried over.
   */
  const tuesdayRow = () => ({
    id: 'series-1',
    occurrence_date: new Date(OCCURRENCE),
    pages: [{ page: { id: 'page-a', title: 'Page A', is_draft: false } }],
    slides: [{ slide: { id: 'deck-a', title: 'Deck A', is_draft: false } }],
    assignments: [],
    featured_resource: { kind: 'slide', id: 'deck-a', title: 'Deck A', is_draft: false },
    _rawPageLinks: [
      { page_id: 'page-a', occurrence_date: BUCKET, featured: false },
      { page_id: 'page-15th', occurrence_date: OTHER_BUCKET, featured: true },
    ],
    _rawSlideLinks: [{ slide_id: 'deck-a', occurrence_date: BUCKET, featured: true }],
    _rawAssignmentLinks: [],
  });
  const thursdayRow = () => ({
    id: 'series-1',
    occurrence_date: new Date('2026-10-15T14:00:00.000Z'),
    pages: [{ page: { id: 'page-15th', title: 'Page 15th', is_draft: false } }],
    slides: [],
    assignments: [],
    featured_resource: { kind: 'page', id: 'page-15th', title: 'Page 15th', is_draft: false },
    _rawPageLinks: tuesdayRow()._rawPageLinks,
    _rawSlideLinks: tuesdayRow()._rawSlideLinks,
    _rawAssignmentLinks: [],
  });
  /** A deadline row in the same window: another id, never the target. */
  const deadlineRow = { id: 'deadline-x', event_type: 'DEADLINE', pages: [], slides: [] };

  const BASE = { classroom: 'org/winter-2025', event_id: 'series-1' };

  const page = (id: string, classroomId = 'class-1') => ({
    id,
    title: `Title ${id}`,
    classroom_id: classroomId,
  });

  beforeEach(() => {
    mocks.getEventById.mockResolvedValue(SERIES);
    mocks.getClassroomCalendar.mockResolvedValue([deadlineRow, tuesdayRow(), thursdayRow()]);
    mocks.updateEventLinks.mockResolvedValue({
      success: true,
      linked: { pages: 0, slides: 0, assignments: 0 },
    });
    mocks.pageFindById.mockImplementation(async (id: string) => page(id));
    mocks.slideFindById.mockImplementation(async (id: string) => ({
      id,
      title: `Title ${id}`,
      classroom_id: 'class-1',
      classroom: { id: 'class-1', git_organization: { login: 'org' } },
    }));
    mocks.assignmentFindById.mockImplementation(async (id: string) => ({
      id,
      type: 'REPO',
      title: `Title ${id}`,
      module: { classroom_id: 'class-1' },
      repository: { classroom_id: 'class-1' },
    }));
    mocks.quizzesVisible.mockResolvedValue(true);
  });

  /** The arguments of the one updateEventLinks call. */
  const written = () => {
    expect(mocks.updateEventLinks).toHaveBeenCalledTimes(1);
    const [eventId, classroomId, lists, occurrence, featured] =
      mocks.updateEventLinks.mock.calls[0];
    return { eventId, classroomId, lists, occurrence, featured };
  };

  it('requires occurrence_date on a recurring event', async () => {
    await expectInvalidParams(
      calendarEventLinksSetTool.handler({ ...BASE, page_ids: [] }, CTX) as Promise<unknown>
    );
    expect(mocks.getClassroomCalendar).not.toHaveBeenCalled();
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('refuses occurrence_date on a non-recurring event', async () => {
    mocks.getEventById.mockResolvedValue(TIMED_EVENT);
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, event_id: 'event-2', occurrence_date: OCCURRENCE, page_ids: [] },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('refuses a date that is not an occurrence of the event', async () => {
    // The 14th is a Wednesday: the series produces no row for it.
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: '2026-10-14T14:00:00.000Z', page_ids: [] },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('matches the same instant written in another offset', async () => {
    await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: '2026-10-13T10:00:00-04:00', page_ids: [] },
      CTX
    );
    expect(written().occurrence).toEqual(new Date(OCCURRENCE));
  });

  it('refuses another instant on the same UTC day', async () => {
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: '2026-10-13T00:00:00.000Z', page_ids: [] },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it("refuses a local midnight that falls on the previous occurrence's UTC day", async () => {
    // A Berlin Mon/Tue series at 10:00 CEST (08:00Z). Tuesday local midnight is
    // Monday 22:00Z: matched by UTC day it would write Monday's links.
    mocks.getEventById.mockResolvedValue({
      ...SERIES,
      recurrence_rule: { days: ['monday', 'tuesday'] },
    });
    mocks.getClassroomCalendar.mockResolvedValue([
      { ...tuesdayRow(), occurrence_date: new Date('2026-10-12T08:00:00.000Z') },
      { ...tuesdayRow(), occurrence_date: new Date('2026-10-13T08:00:00.000Z') },
    ]);
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: '2026-10-13T00:00:00+02:00', page_ids: [] },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('treats a recurring flag whose rule names no days as a single event', async () => {
    // calendar_event_create accepts this rule; the calendar shows the event
    // once, undated, reading the undated bucket.
    const flagged = { ...SERIES, recurrence_rule: { until: '2026-12-31' } };
    mocks.getEventById.mockResolvedValue(flagged);
    mocks.getClassroomCalendar.mockResolvedValue([
      {
        id: 'series-1',
        pages: [{ page: { id: 'page-u', title: 'Undated' } }],
        slides: [],
        assignments: [],
        _rawPageLinks: [{ page_id: 'page-u', occurrence_date: null, featured: true }],
        _rawSlideLinks: [],
        _rawAssignmentLinks: [],
      },
    ]);

    // A date is refused: there is no dated occurrence to name.
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE, slide_ids: [] },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();

    // Without one it writes the undated bucket, around the event's own start.
    await calendarEventLinksSetTool.handler({ ...BASE, slide_ids: ['deck-n'] }, CTX);
    const [, start] = mocks.getClassroomCalendar.mock.calls[0];
    expect((start as Date).getTime()).toBe(flagged.start_time.getTime() - 2 * 86_400_000);
    const call = written();
    expect(call.occurrence).toBeNull();
    expect(call.lists).toEqual({ pageIds: ['page-u'], slideIds: ['deck-n'], assignmentIds: [] });
    expect(call.featured).toEqual({ kind: 'page', id: 'page-u' });
  });

  it('requires something to set', async () => {
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it("refuses an assistant changing someone else's event", async () => {
    await expect(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE, page_ids: [] },
        ASSISTANT_CTX
      )
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('lets an assistant change their own event', async () => {
    mocks.getEventById.mockResolvedValue({ ...SERIES, created_by: 'ta-1' });
    await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, page_ids: [] },
      ASSISTANT_CTX
    );
    expect(mocks.updateEventLinks).toHaveBeenCalledTimes(1);
  });

  it('answers an event in another classroom as not found', async () => {
    mocks.getEventById.mockResolvedValue({ ...SERIES, classroom_id: 'class-2' });
    await expect(
      calendarEventLinksSetTool.handler({ ...BASE, occurrence_date: OCCURRENCE, page_ids: [] }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.getClassroomCalendar).not.toHaveBeenCalled();
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('answers a foreign and a nonexistent page id with the same not found, writing nothing', async () => {
    mocks.pageFindById.mockImplementation(async (id: string) =>
      id === 'page-foreign' ? page(id, 'class-2') : null
    );
    const errors = [];
    for (const id of ['page-foreign', 'page-missing']) {
      const error = await calendarEventLinksSetTool
        .handler({ ...BASE, occurrence_date: OCCURRENCE, page_ids: ['page-a', id] }, CTX)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ kind: 'not_found' });
      errors.push((error as Error).message);
    }
    expect(errors[0]).toBe(errors[1]);
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a foreign deck and a foreign assignment the same way', async () => {
    mocks.slideFindById.mockResolvedValue({
      id: 'deck-x',
      classroom_id: 'class-2',
      classroom: { id: 'class-2', git_organization: { login: 'other' } },
    });
    await expect(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE, slide_ids: ['deck-x'] },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });

    mocks.assignmentFindById.mockResolvedValue({
      id: 'asg-x',
      type: 'QUIZ',
      module: { classroom_id: 'class-2' },
      repository: null,
    });
    await expect(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE, assignment_ids: ['asg-x'] },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('answers a quiz assignment as not found where quizzes are hidden', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);
    mocks.assignmentFindById.mockResolvedValue({
      id: 'quiz-asg',
      type: 'QUIZ',
      title: 'Quiz',
      module: { classroom_id: 'class-1' },
      repository: null,
    });
    await expect(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE, assignment_ids: ['quiz-asg'] },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('leaves a hidden quiz link and its star to the service', async () => {
    // Stored on the 13th: a starred quiz link. Where quizzes are hidden the
    // calendar strips it before expansion, so neither the display nor the raw
    // rows carry it, and this date reads as having no star.
    mocks.getClassroomCalendar.mockResolvedValue([
      {
        ...tuesdayRow(),
        slides: [],
        featured_resource: null,
        _rawSlideLinks: [],
        _rawAssignmentLinks: [],
      },
    ]);
    const result = await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, page_ids: ['page-a'] },
      CTX
    );
    const call = written();
    // The quiz is neither re-sent nor starred: the service keeps the stored
    // link (and its star) because quizzes are hidden, and clears that star
    // only when a new one is set.
    expect(call.lists.assignmentIds).toEqual([]);
    expect(call.featured).toBeNull();
    expect(parse(result).featured).toBeNull();
    expect(mocks.assignmentFindById).not.toHaveBeenCalled();
  });

  it('does not re-check ids already linked to this date', async () => {
    await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, page_ids: ['page-a'] },
      CTX
    );
    expect(mocks.pageFindById).not.toHaveBeenCalled();
  });

  it("keeps an omitted kind's current links, from this date only", async () => {
    const result = await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, page_ids: ['page-b', 'page-a', 'page-b'] },
      CTX
    );
    const call = written();
    expect(call.eventId).toBe('series-1');
    expect(call.classroomId).toBe('class-1');
    // Deduped in the order given; deck-a carried over; the 15th's page-15th
    // is not.
    expect(call.lists).toEqual({
      pageIds: ['page-b', 'page-a'],
      slideIds: ['deck-a'],
      assignmentIds: [],
    });
    expect(call.occurrence).toBeInstanceOf(Date);
    expect(call.occurrence).toEqual(new Date(OCCURRENCE));
    // The star on deck-a is still linked, so it stays.
    expect(call.featured).toEqual({ kind: 'slide', id: 'deck-a' });

    expect(parse(result)).toEqual({
      success: true,
      event_id: 'series-1',
      occurrence_date: OCCURRENCE,
      pages: [
        { id: 'page-b', title: 'Title page-b' },
        { id: 'page-a', title: 'Page A' },
      ],
      slides: [{ id: 'deck-a', title: 'Deck A' }],
      assignments: [],
      featured: { kind: 'slide', id: 'deck-a' },
    });
  });

  it('clears a kind with [] and drops a star whose resource went with it', async () => {
    await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, slide_ids: [] },
      CTX
    );
    const call = written();
    expect(call.lists).toEqual({ pageIds: ['page-a'], slideIds: [], assignmentIds: [] });
    expect(call.featured).toBeNull();
  });

  it('refuses a star on something not in the resulting list', async () => {
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        {
          ...BASE,
          occurrence_date: OCCURRENCE,
          featured: { kind: 'page', id: 'page-15th' },
        },
        CTX
      ) as Promise<unknown>
    );
    // Right id, wrong kind: still not linked as what the caller said it is.
    await expectInvalidParams(
      calendarEventLinksSetTool.handler(
        { ...BASE, occurrence_date: OCCURRENCE, featured: { kind: 'page', id: 'deck-a' } },
        CTX
      ) as Promise<unknown>
    );
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('stars a resource linked in the same call, and null removes the star', async () => {
    await calendarEventLinksSetTool.handler(
      {
        ...BASE,
        occurrence_date: OCCURRENCE,
        assignment_ids: ['asg-1'],
        featured: { kind: 'assignment', id: 'asg-1' },
      },
      CTX
    );
    expect(written().featured).toEqual({ kind: 'assignment', id: 'asg-1' });
    expect(written().lists.assignmentIds).toEqual(['asg-1']);

    mocks.updateEventLinks.mockClear();
    await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, featured: null },
      CTX
    );
    expect(written().featured).toBeNull();
    // Nothing else changes.
    expect(written().lists).toEqual({
      pageIds: ['page-a'],
      slideIds: ['deck-a'],
      assignmentIds: [],
    });
  });

  it('writes a non-recurring event to the undated bucket, ignoring dated links on its day', async () => {
    mocks.getEventById.mockResolvedValue(TIMED_EVENT);
    mocks.getClassroomCalendar.mockResolvedValue([
      {
        id: 'event-2',
        // A flattened series: the display shows the undated page and a dated
        // one that falls on the event's day; only the first is in the bucket
        // this write replaces.
        pages: [
          { page: { id: 'page-undated', title: 'Undated' } },
          { page: { id: 'page-dated', title: 'Dated' } },
        ],
        slides: [],
        assignments: [],
        _rawPageLinks: [
          { page_id: 'page-undated', occurrence_date: null, featured: false },
          {
            page_id: 'page-dated',
            occurrence_date: new Date('2026-07-20T00:00:00Z'),
            featured: true,
          },
        ],
        _rawSlideLinks: [],
        _rawAssignmentLinks: [],
      },
    ]);
    const result = await calendarEventLinksSetTool.handler(
      { ...BASE, event_id: 'event-2', slide_ids: ['deck-n'] },
      CTX
    );

    const [classroomId, start, end, userId, raw, unpublished, options] =
      mocks.getClassroomCalendar.mock.calls[0];
    expect(classroomId).toBe('class-1');
    expect((start as Date).getTime()).toBe(TIMED_EVENT.start_time.getTime() - 2 * 86_400_000);
    expect((end as Date).getTime()).toBe(TIMED_EVENT.start_time.getTime() + 2 * 86_400_000);
    expect([userId, raw, unpublished, options]).toEqual([null, true, true, { canSeeDrafts: true }]);

    const call = written();
    expect(call.occurrence).toBeNull();
    expect(call.lists).toEqual({
      pageIds: ['page-undated'],
      slideIds: ['deck-n'],
      assignmentIds: [],
    });
    // The dated star belongs to the other bucket.
    expect(call.featured).toBeNull();
    expect(parse(result).occurrence_date).toBeNull();
  });

  it('audits the write with the tool name, date, saved counts and star', async () => {
    mocks.updateEventLinks.mockResolvedValue({
      success: true,
      linked: { pages: 1, slides: 1, assignments: 0 },
    });
    await calendarEventLinksSetTool.handler(
      { ...BASE, occurrence_date: OCCURRENCE, page_ids: ['page-a'] },
      CTX
    );
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const [row, options] = mocks.auditCreate.mock.calls[0];
    // One row per call: setting several dates of a series in quick succession
    // must not collapse into the first.
    expect(options).toEqual({ dedupe: false });
    expect(row).toMatchObject({
      user_id: 'owner-1',
      classroom_id: 'class-1',
      role: 'OWNER',
      resource_type: 'CALENDAR',
      resource_id: 'series-1',
      action: 'UPDATE',
      data: {
        tool: 'calendar_event_links_set',
        occurrence_date: OCCURRENCE,
        linked: { pages: 1, slides: 1, assignments: 0 },
        featured: { kind: 'slide', id: 'deck-a' },
      },
    });
  });

  it('answers an event deleted mid-call as not found', async () => {
    mocks.updateEventLinks.mockRejectedValue(
      new Error('Calendar event not found in this classroom')
    );
    await expect(
      calendarEventLinksSetTool.handler({ ...BASE, occurrence_date: OCCURRENCE, page_ids: [] }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('is a non-destructive, idempotent write for the teaching team', () => {
    expect(calendarEventLinksSetTool.scope).toBe('write');
    expect(calendarEventLinksSetTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(calendarEventLinksSetTool.annotations).toEqual({
      destructive: false,
      idempotent: true,
    });
    expect(Buffer.byteLength(calendarEventLinksSetTool.description)).toBeLessThan(1500);
  });

  it('caps each id list at 50', () => {
    const schema = z.object(calendarEventLinksSetTool.inputSchema);
    const ids = Array.from({ length: 51 }, () => crypto.randomUUID());
    expect(
      schema.safeParse({ ...BASE, event_id: crypto.randomUUID(), page_ids: ids }).success
    ).toBe(false);
    expect(
      schema.safeParse({ ...BASE, event_id: crypto.randomUUID(), page_ids: ids.slice(1) }).success
    ).toBe(true);
  });
});
