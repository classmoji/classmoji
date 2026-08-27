/**
 * Unit tests for the admin calendar action's audit rows.
 *
 * Calendar writes are the ones most likely to be disputed after the fact — a
 * moved deadline or a deleted lecture changes what a whole class is expected to
 * do — and none of them recorded anything, while the MCP calendar tools have
 * always audited theirs.
 *
 * Events use the MCP calendar vocabulary ('CALENDAR'). The deadline branch
 * mutates an Assignment rather than a CalendarEvent, so it uses the MCP
 * assignment vocabulary ('ASSIGNMENT') and is keyed on the assignment id —
 * writing it as CALENDAR would file it under a record that never changed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  updateEventWithScope: vi.fn(),
  updateEventLinks: vi.fn(),
  deleteEvent: vi.fn(),
  deleteEventWithScope: vi.fn(),
  getEventById: vi.fn(),
  assignmentFindById: vi.fn(),
  assignmentUpdate: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
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
    assignment: {
      findById: (...a: unknown[]) => mocks.assignmentFindById(...a),
      update: (...a: unknown[]) => mocks.assignmentUpdate(...a),
    },
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    page: { findMany: vi.fn() },
    slide: { findMany: vi.fn() },
    assignment: { findMany: vi.fn() },
  }),
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/utils/calendar.server', () => ({
  buildCalendarUrl: () => 'webcal://example.test/cal.ics',
  getCalendarDateRange: () => ({ start: new Date(0), end: new Date(0) }),
}));
vi.mock('antd', () => ({ Button: () => null, Modal: () => null }));
vi.mock('@ant-design/icons', () => ({ PlusOutlined: () => null }));
vi.mock('~/components/features/calendar/CourseCalendar', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/CalendarSubscriptionCard', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/AddEventModal', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EditEventModal', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EventCard', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EventLinks', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/utils', () => ({}));
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    data: actual.data,
    useFetcher: () => ({ submit: vi.fn() }),
    useLocation: () => ({ pathname: '/admin/cs52-26f/calendar' }),
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
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/calendar`, {
      method: 'POST',
      body: formData,
    }),
  } as unknown as Parameters<typeof route.action>[0]);
};

/** The single audit entry the action wrote. */
const auditEntry = () =>
  mocks.addClassroomAuditLog.mock.calls[0][0] as {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.createEvent.mockResolvedValue({ id: 'event-new' });
  mocks.getEventById.mockResolvedValue({
    id: 'event-1',
    classroom_id: 'class-1',
    created_by: 'owner-1',
    title: 'Lecture 3',
  });
  mocks.assignmentFindById.mockResolvedValue({
    id: 'assignment-1',
    repository: { classroom_id: 'class-1' },
    student_deadline: new Date('2026-01-01T00:00:00.000Z'),
  });
});

describe('calendar action — audit rows', () => {
  it('audits createEvent as CREATE against the new event', async () => {
    await submit({
      intent: 'create',
      eventData: JSON.stringify({ title: 'Lecture 4', event_type: 'LECTURE' }),
    });

    expect(auditEntry()).toMatchObject({
      action: 'CREATE',
      resourceType: 'CALENDAR',
      resourceId: 'event-new',
      metadata: {
        tool: 'web:calendar.create_event',
        title: 'Lecture 4',
        event_type: 'LECTURE',
        is_recurring: false,
      },
    });
  });

  it('records the edit scope on a recurring update, since scope decides how much moved', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Moved',
        editScope: 'this_only',
        occurrenceDate: '2026-02-01',
      }),
    });

    expect(auditEntry()).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CALENDAR',
      resourceId: 'event-1',
      metadata: {
        tool: 'web:calendar.update_event',
        fields: ['title'],
        edit_scope: 'this_only',
        occurrence_date: '2026-02-01',
      },
    });
  });

  it('audits a delete with the scope that decided how many occurrences went away', async () => {
    await submit({
      intent: 'delete',
      eventId: 'event-1',
      deleteOptions: JSON.stringify({ editScope: 'all', occurrenceDate: '2026-02-01' }),
    });

    expect(auditEntry()).toMatchObject({
      action: 'DELETE',
      resourceType: 'CALENDAR',
      resourceId: 'event-1',
      metadata: {
        tool: 'web:calendar.delete_event',
        title: 'Lecture 3',
        delete_scope: 'all',
      },
    });
  });

  it('audits a deadline move as an ASSIGNMENT update carrying both ends', async () => {
    // "The deadline changed" is not a useful audit row; what it moved from and
    // to is the whole point.
    await submit({
      intent: 'update_deadline',
      assignmentId: 'assignment-1',
      newDeadline: '2026-03-05T23:59:00.000Z',
    });

    expect(auditEntry()).toMatchObject({
      action: 'UPDATE',
      resourceType: 'ASSIGNMENT',
      resourceId: 'assignment-1',
      metadata: {
        tool: 'web:calendar.update_deadline',
        fields: ['student_deadline'],
        previous_deadline: '2026-01-01T00:00:00.000Z',
        new_deadline: '2026-03-05T23:59:00.000Z',
      },
    });
  });

  it('writes no row when the event belongs to another classroom', async () => {
    mocks.getEventById.mockResolvedValue({ id: 'event-x', classroom_id: 'other-class' });

    await submit({ intent: 'delete', eventId: 'event-x' });

    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when an assistant is refused the deadline move', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'ta-1',
      classroom: CLASSROOM,
      membership: { id: 'm-2', role: 'ASSISTANT' },
    });

    await submit({
      intent: 'update_deadline',
      assignmentId: 'assignment-1',
      newDeadline: '2026-03-05T23:59:00.000Z',
    });

    expect(mocks.assignmentUpdate).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

/**
 * The office-hours limit on assistants is a ROLE policy, so it has to be
 * enforced on the role — not on which of the two URLs serving this action the
 * client happened to POST to.
 *
 * The /assistant variant of this page has always rejected non-OFFICE_HOURS
 * creates, but this action's gate admits ASSISTANT as well, and in React Router
 * a POST runs the matched leaf's action directly — the /admin layout's loader
 * is not in that path. So an assistant POSTing here bypassed the restriction
 * entirely until the check moved onto `isAdmin`, which the update, delete and
 * deadline branches already consulted.
 */
describe('calendar action — the assistant event-type limit follows the role', () => {
  const asAssistant = () =>
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'ta-1',
      classroom: CLASSROOM,
      membership: { id: 'm-2', role: 'ASSISTANT' },
    });

  it('refuses an assistant creating a lecture on the admin URL', async () => {
    asAssistant();

    const response = (await submit({
      intent: 'create',
      eventData: JSON.stringify({ title: 'Lecture 4', event_type: 'LECTURE' }),
    })) as { init?: { status?: number } };

    expect(response.init?.status).toBe(403);
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('still lets an assistant create office hours', async () => {
    asAssistant();

    await submit({
      intent: 'create',
      eventData: JSON.stringify({ title: 'OH', event_type: 'OFFICE_HOURS' }),
    });

    expect(mocks.createEvent).toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({ action: 'CREATE', resourceType: 'CALENDAR' });
  });

  it.each(['OWNER', 'TEACHER'])('does not limit a %s to office hours', async role => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'staff-1',
      classroom: CLASSROOM,
      membership: { id: 'm-3', role },
    });

    await submit({
      intent: 'create',
      eventData: JSON.stringify({ title: 'Lecture 4', event_type: 'LECTURE' }),
    });

    expect(mocks.createEvent).toHaveBeenCalled();
  });
});
