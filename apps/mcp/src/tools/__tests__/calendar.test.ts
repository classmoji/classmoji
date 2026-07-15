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
  updateEvent: vi.fn(),
  updateEventWithScope: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    calendar: {
      getEventById: (...a: unknown[]) => mocks.getEventById(...a),
      updateEvent: (...a: unknown[]) => mocks.updateEvent(...a),
      updateEventWithScope: (...a: unknown[]) => mocks.updateEventWithScope(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { calendarEventUpdateTool } = await import('../calendar.ts');

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

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getEventById.mockResolvedValue(RECURRING_EVENT);
  mocks.updateEventWithScope.mockResolvedValue(RECURRING_EVENT);
  mocks.auditCreate.mockResolvedValue(undefined);
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
