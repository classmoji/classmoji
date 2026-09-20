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
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  getEventById: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  updateEventWithScope: vi.fn(),
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
const { ASSISTANT_EVENT_TYPE_MESSAGE } = await import('@classmoji/services/calendar-policy');

const { calendarEventCreateTool, calendarEventUpdateTool } = await import('../calendar.ts');

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
