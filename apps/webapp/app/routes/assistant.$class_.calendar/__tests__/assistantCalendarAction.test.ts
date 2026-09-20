/**
 * The assistant calendar action's own gates.
 *
 * This route serves assistants only, so every caller it admits is subject to
 * the office-hours limit — there is no `isAdmin` branch to fall through. The
 * limit has to hold on UPDATE as well as create, or it is only as strong as the
 * create form: add office hours, then change the type.
 *
 * The same policy is applied by the admin action (which serves this screen to
 * owners and teachers as well) and by the MCP calendar tools. All three ask the
 * same dependency-free module, which is NOT mocked here, so this asserts the
 * real decision rather than a copy of it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  updateEventWithScope: vi.fn(),
  updateEventLinks: vi.fn(),
  deleteEvent: vi.fn(),
  deleteEventWithScope: vi.fn(),
  getEventById: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    calendar: {
      createEvent: (...a: unknown[]) => mocks.createEvent(...a),
      updateEvent: (...a: unknown[]) => mocks.updateEvent(...a),
      updateEventWithScope: (...a: unknown[]) => mocks.updateEventWithScope(...a),
      updateEventLinks: (...a: unknown[]) => mocks.updateEventLinks(...a),
      deleteEvent: (...a: unknown[]) => mocks.deleteEvent(...a),
      deleteEventWithScope: (...a: unknown[]) => mocks.deleteEventWithScope(...a),
      getEventById: (...a: unknown[]) => mocks.getEventById(...a),
      getClassroomCalendar: vi.fn(),
    },
  },
}));

const { ASSISTANT_EVENT_TYPE_MESSAGE } = await import('@classmoji/services/calendar-policy');

vi.mock('@classmoji/database', () => ({
  default: () => ({
    page: { findMany: vi.fn() },
    slide: { findMany: vi.fn() },
    assignment: { findMany: vi.fn() },
  }),
}));

// The view layer only needs to import; every calendar module the route pulls in
// at runtime is stubbed, or this node test drags antd and a React tree with it.
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/utils/calendar.server', () => ({
  buildCalendarUrl: () => 'webcal://example.test/cal.ics',
  getCalendarDateRange: () => ({ start: new Date(0), end: new Date(0) }),
}));
vi.mock('~/utils/classroomStatusModals', () => ({
  useClassroomStatusModals: () => ({ showStatusErrorFromResponse: vi.fn() }),
}));
vi.mock('antd', () => ({ Button: () => null, Modal: () => null }));
vi.mock('@ant-design/icons', () => ({ PlusOutlined: () => null }));
vi.mock('~/components/features/calendar/CourseCalendar', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/CalendarSubscriptionCard', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/AddEventModal', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EditEventModal', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EventCard', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EventLinks', () => ({ default: () => null }));
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    data: actual.data,
    useFetcher: () => ({ submit: vi.fn() }),
    useParams: () => ({ class: 'cs52-26f' }),
  };
});

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

const submit = (body: Record<string, string>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.append(key, value);
  return route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/assistant/${CLASS_SLUG}/calendar`, {
      method: 'POST',
      body: formData,
    }),
  } as unknown as Parameters<typeof route.action>[0]) as Promise<{
    data?: { error?: string };
    init?: { status?: number };
  }>;
};

/** The assistant's own office-hours event, as the action loads it. */
const ownOfficeHours = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  classroom_id: 'class-1',
  created_by: 'ta-1',
  event_type: 'OFFICE_HOURS',
  title: 'Office hours',
  ...over,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'ta-1',
    classroom: CLASSROOM,
    membership: { id: 'm-2', role: 'ASSISTANT' },
  });
  mocks.createEvent.mockResolvedValue({ id: 'event-new' });
  mocks.getEventById.mockResolvedValue(ownOfficeHours());
});

describe('the office-hours limit holds on create', () => {
  it('refuses another event type', async () => {
    const response = await submit({
      intent: 'create',
      eventData: JSON.stringify({ event_type: 'LECTURE', title: 'Lecture 4' }),
    });

    expect(response.init?.status).toBe(403);
    expect(response.data?.error).toBe(ASSISTANT_EVENT_TYPE_MESSAGE);
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('allows office hours', async () => {
    await submit({
      intent: 'create',
      eventData: JSON.stringify({ event_type: 'OFFICE_HOURS', title: 'OH' }),
    });

    expect(mocks.createEvent).toHaveBeenCalled();
  });
});

describe('the office-hours limit holds on update', () => {
  it('refuses retyping an office-hours event as a lecture', async () => {
    const response = await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours', event_type: 'LECTURE' }),
    });

    expect(response.init?.status).toBe(403);
    expect(response.data?.error).toBe(ASSISTANT_EVENT_TYPE_MESSAGE);
    expect(mocks.updateEvent).not.toHaveBeenCalled();
    expect(mocks.updateEventWithScope).not.toHaveBeenCalled();
  });

  it('allows an edit that leaves the type alone', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours (moved)', location: 'ECSC 004' }),
    });

    expect(mocks.updateEvent).toHaveBeenCalled();
  });

  it('allows re-sending the type the event already has', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours', event_type: 'OFFICE_HOURS' }),
    });

    expect(mocks.updateEvent).toHaveBeenCalled();
  });

  it('lets an assistant move an event somebody else retyped back to office hours', async () => {
    mocks.getEventById.mockResolvedValue(ownOfficeHours({ event_type: 'LECTURE' }));

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours', event_type: 'OFFICE_HOURS' }),
    });

    expect(mocks.updateEvent).toHaveBeenCalled();
  });
});

describe('resource links follow the scope here too', () => {
  it.each(['all', 'this_and_future'])('ignores link keys sent with a %s edit', async scope => {
    mocks.updateEventWithScope.mockResolvedValue({ id: 'event-2' });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Office hours',
        editScope: scope,
        occurrenceDate: '2026-09-28T00:00:00.000Z',
        linkedPageIds: ['p-1'],
      }),
    });

    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });

  it('writes them for a this-only edit, against the event the service returned', async () => {
    mocks.updateEventWithScope.mockResolvedValue({ id: 'event-2' });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Office hours',
        editScope: 'this_only',
        occurrenceDate: '2026-09-28T00:00:00.000Z',
        linkedPageIds: ['p-1'],
      }),
    });

    expect(mocks.updateEventLinks).toHaveBeenCalledWith(
      'event-2',
      'class-1',
      { pageIds: ['p-1'], slideIds: [], assignmentIds: [] },
      new Date('2026-09-28T00:00:00.000Z')
    );
  });
});

describe('an event still has to be this assistant’s own, in this classroom', () => {
  it('refuses another classroom’s event', async () => {
    mocks.getEventById.mockResolvedValue(ownOfficeHours({ classroom_id: 'other-class' }));

    const response = await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours' }),
    });

    expect(response.init?.status).toBe(404);
    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  it('refuses somebody else’s event', async () => {
    mocks.getEventById.mockResolvedValue(ownOfficeHours({ created_by: 'owner-1' }));

    const response = await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours' }),
    });

    expect(response.init?.status).toBe(403);
    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });
});
