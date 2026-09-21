/**
 * Unit tests for the admin calendar action: the audit row every write leaves,
 * which event a link write lands on, and how a refusal reaches the user.
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

// The write policy is NOT mocked: it is a dependency-free module, so the action
// runs the real decision here and these tests cannot pass against a copy of it.
const { CalendarTimeRangeError, ASSISTANT_EVENT_TYPE_MESSAGE } =
  await import('@classmoji/services/calendar-policy');

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
//
// Every calendar module the route imports AT RUNTIME belongs in the list below,
// or importing the route drags a React component tree (and antd) into this node
// test. Type-only imports need no entry — the transform erases them — which is
// why `calendar/types` and the modal's form types are absent.
//
// The shared calendar parts — CalendarShell, WeekGrid, MonthGrid, AllDayStrip,
// NowIndicator, EventChip, geometry, useCalendarNavigation and the drag
// layer — need no entries of their own: the route reaches every one of them
// through CourseCalendar, which is mocked here. An entry is needed the day the
// route imports one of them DIRECTLY.
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
describe('calendar action — which event a link write lands on', () => {
  it('writes the links against the occurrence being edited', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        editScope: 'this_only',
        occurrenceDate: '2026-09-28T00:00:00.000Z',
        linkedPageIds: ['p-1'],
        linkedSlideIds: [],
        linkedAssignmentIds: [],
      }),
    });

    expect(mocks.updateEventLinks).toHaveBeenCalledWith(
      'event-1',
      'class-1',
      { pageIds: ['p-1'], slideIds: [], assignmentIds: [] },
      new Date('2026-09-28T00:00:00.000Z'),
      null
    );
  });

  it.each(['all', 'this_and_future'])('ignores link keys sent with a %s edit', async scope => {
    // Those scopes name no occurrence, and a link written without one lands in
    // the undated bucket that a recurring event's occurrences never read: it
    // would look like saving the links and behave like discarding them. The
    // modal no longer sends them, and the action would not write them if it did.
    mocks.updateEventWithScope.mockResolvedValue({ id: 'event-2' });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        editScope: scope,
        occurrenceDate: '2026-09-28T00:00:00.000Z',
        linkedPageIds: ['p-1'],
        linkedSlideIds: [],
        linkedAssignmentIds: [],
      }),
    });

    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
    // The rest of the edit still goes through.
    expect(mocks.updateEventWithScope).toHaveBeenCalled();
  });

  it('follows a split onto the returned event when a link write does happen', async () => {
    // 'this_only' is the scope that carries links. The id still has to be the
    // one the service wrote, since a scoped call is what returns it.
    mocks.updateEventWithScope.mockResolvedValue({ id: 'event-2' });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        editScope: 'this_only',
        occurrenceDate: '2026-09-28T00:00:00.000Z',
        linkedPageIds: ['p-1'],
      }),
    });

    expect(mocks.updateEventLinks).toHaveBeenCalledWith(
      'event-2',
      'class-1',
      expect.anything(),
      new Date('2026-09-28T00:00:00.000Z'),
      null
    );
  });

  it('writes no links at all when the edit carried none', async () => {
    // The modal sends the link arrays only for a 'this only' edit, and the
    // action keys off their presence — so a series-wide edit must leave every
    // date's links exactly as they were.
    mocks.updateEventWithScope.mockResolvedValue({ id: 'event-1' });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Renamed',
        editScope: 'all',
        occurrenceDate: '2026-09-28T00:00:00.000Z',
      }),
    });

    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
  });
});

describe('calendar action — the starred link', () => {
  /** The `featured` argument of the single updateEventLinks call. */
  const featuredArg = () => mocks.updateEventLinks.mock.calls[0][4];

  it('travels to the link write on a create', async () => {
    await submit({
      intent: 'create',
      eventData: JSON.stringify({
        title: 'Lecture 4',
        event_type: 'LECTURE',
        linkedPageIds: ['p-1'],
        featuredKind: 'page',
        featuredId: 'p-1',
      }),
    });

    expect(featuredArg()).toEqual({ kind: 'page', id: 'p-1' });
  });

  it('never reaches createEvent, which knows nothing about links', async () => {
    await submit({
      intent: 'create',
      eventData: JSON.stringify({
        title: 'Lecture 4',
        event_type: 'LECTURE',
        linkedPageIds: ['p-1'],
        featuredKind: 'page',
        featuredId: 'p-1',
      }),
    });

    const createData = mocks.createEvent.mock.calls[0][2] as Record<string, unknown>;
    expect(createData).not.toHaveProperty('featuredKind');
    expect(createData).not.toHaveProperty('featuredId');
    expect(createData).not.toHaveProperty('linkedPageIds');
  });

  it('travels with a this_only edit', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        editScope: 'this_only',
        occurrenceDate: '2026-09-28T00:00:00.000Z',
        linkedSlideIds: ['s-1'],
        featuredKind: 'slide',
        featuredId: 's-1',
      }),
    });

    expect(featuredArg()).toEqual({ kind: 'slide', id: 's-1' });
  });

  it.each(['all', 'this_and_future'])(
    'is ignored with a %s edit, as the links are',
    async scope => {
      // A star is stored on a link row. A scope that has no occurrence to save a
      // link against has nowhere to put a star either.
      mocks.updateEventWithScope.mockResolvedValue({ id: 'event-2' });

      await submit({
        intent: 'update',
        eventId: 'event-1',
        eventData: JSON.stringify({
          title: 'Lecture 3',
          editScope: scope,
          occurrenceDate: '2026-09-28T00:00:00.000Z',
          linkedPageIds: ['p-1'],
          featuredKind: 'page',
          featuredId: 'p-1',
        }),
      });

      expect(mocks.updateEventLinks).not.toHaveBeenCalled();
    }
  );

  it('is dropped when it names a kind the calendar does not have', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        linkedPageIds: ['p-1'],
        featuredKind: 'quiz',
        featuredId: 'q-1',
      }),
    });

    expect(featuredArg()).toBeNull();
  });

  it('is not claimed among the fields an update changed', async () => {
    // The audit row lists which columns of the EVENT moved. A star is not one
    // of them, and neither are the link ids beside it.
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        linkedPageIds: ['p-1'],
        featuredKind: 'page',
        featuredId: 'p-1',
      }),
    });

    expect(auditEntry().metadata.fields).toEqual(['title']);
  });

  it('never reaches updateEvent either', async () => {
    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({
        title: 'Lecture 3',
        linkedPageIds: ['p-1'],
        featuredKind: 'page',
        featuredId: 'p-1',
      }),
    });

    const updateData = mocks.updateEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(updateData)).toEqual(['title']);
  });
});

describe('calendar action — a refused time range reaches the user', () => {
  it('answers a create with the message, not a 500', async () => {
    mocks.createEvent.mockRejectedValue(new CalendarTimeRangeError());

    const response = (await submit({
      intent: 'create',
      eventData: JSON.stringify({ title: 'Backwards', event_type: 'LECTURE' }),
    })) as { data?: { error?: string }; init?: { status?: number } };

    expect(response.init?.status).toBe(400);
    expect(response.data?.error).toBe('End time must be after the start time');
    // Nothing was written, so nothing is claimed in the log.
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('answers an update the same way, and writes no links after it', async () => {
    mocks.updateEvent.mockRejectedValue(new CalendarTimeRangeError());

    const response = (await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Backwards', linkedPageIds: ['p-1'] }),
    })) as { data?: { error?: string }; init?: { status?: number } };

    expect(response.init?.status).toBe(400);
    expect(response.data?.error).toBe('End time must be after the start time');
    expect(mocks.updateEventLinks).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('still lets any other failure surface as itself', async () => {
    // Laundering every failure into a friendly message would tell a user to fix
    // their times when the database was down.
    mocks.updateEvent.mockRejectedValue(new Error('connection reset'));

    await expect(
      submit({
        intent: 'update',
        eventId: 'event-1',
        eventData: JSON.stringify({ title: 'Whatever' }),
      })
    ).rejects.toThrow('connection reset');
  });
});

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

  it('refuses an assistant retyping their office hours as a lecture', async () => {
    // The create limit is worth nothing on its own: add office hours, then
    // change the type. Same policy, same message, on the update path.
    asAssistant();
    mocks.getEventById.mockResolvedValue({
      id: 'event-1',
      classroom_id: 'class-1',
      created_by: 'ta-1',
      event_type: 'OFFICE_HOURS',
      title: 'Office hours',
    });

    const response = (await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours', event_type: 'LECTURE' }),
    })) as { data?: { error?: string }; init?: { status?: number } };

    expect(response.init?.status).toBe(403);
    expect(response.data?.error).toBe(ASSISTANT_EVENT_TYPE_MESSAGE);
    expect(mocks.updateEvent).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('still lets an assistant edit the time of their office hours', async () => {
    // The refusal is about the TYPE. Re-sending the one the event already has
    // is not a change, and must not block an ordinary edit.
    asAssistant();
    mocks.getEventById.mockResolvedValue({
      id: 'event-1',
      classroom_id: 'class-1',
      created_by: 'ta-1',
      event_type: 'OFFICE_HOURS',
      title: 'Office hours',
    });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Office hours', event_type: 'OFFICE_HOURS' }),
    });

    expect(mocks.updateEvent).toHaveBeenCalled();
  });

  it('does not stop an OWNER retyping an event', async () => {
    mocks.getEventById.mockResolvedValue({
      id: 'event-1',
      classroom_id: 'class-1',
      created_by: 'owner-1',
      event_type: 'OFFICE_HOURS',
      title: 'Office hours',
    });

    await submit({
      intent: 'update',
      eventId: 'event-1',
      eventData: JSON.stringify({ title: 'Now a lecture', event_type: 'LECTURE' }),
    });

    expect(mocks.updateEvent).toHaveBeenCalled();
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
