import { useState, useEffect } from 'react';
import { Button, Modal } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import invariant from 'tiny-invariant';
import { data, useFetcher, useLocation, useParams } from 'react-router';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import getPrisma from '@classmoji/database';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { buildCalendarUrl, getCalendarDateRange } from '~/utils/calendar.server';
import type { Route } from './+types/route';
import CourseCalendar from '~/components/features/calendar/CourseCalendar';
import type { CalendarEvent } from '~/components/features/calendar/utils';
import CalendarSubscriptionCard from '~/components/features/calendar/CalendarSubscriptionCard';
import AddEventModal, { type AddEventDefaults } from '~/components/features/calendar/AddEventModal';
import EditEventModal, { type EventFormData } from '~/components/features/calendar/EditEventModal';
import EventCard from '~/components/features/calendar/EventCard';
import EventLinks from '~/components/features/calendar/EventLinks';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  invariant(classSlug, 'Classroom is required');

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'CALENDAR',
    attemptedAction: 'view',
  });

  // Check for date params in URL (for fetching specific month)
  const url = new URL(request.url);
  const yearParam = url.searchParams.get('year');
  const monthParam = url.searchParams.get('month');

  // Use requested month or default to current month
  const today = new Date();
  const year = yearParam ? parseInt(yearParam) : today.getFullYear();
  const month = monthParam ? parseInt(monthParam) : today.getMonth();

  const { start, end } = getCalendarDateRange(year, month);

  const role = membership!.role;
  const isAdmin = ['OWNER', 'TEACHER'].includes(role);

  let events: Awaited<ReturnType<typeof ClassmojiService.calendar.getClassroomCalendar>> = [];
  try {
    // Pass includeRawLinks=true for admin UI editing, includeUnpublished=true to see draft assignments
    events = await ClassmojiService.calendar.getClassroomCalendar(
      classroom.id,
      start,
      end,
      null, // userId not needed for admin
      true, // includeRawLinks for editing UI
      true, // includeUnpublished to see draft/unpublished assignments
      // Form-close events link to the responses view only for OWNER/TEACHER —
      // this route also admits ASSISTANT, and that page refuses them.
      { canManageForms: isAdmin }
    );
  } catch (error: unknown) {
    console.error(
      'Calendar service error (likely missing migration):',
      error instanceof Error ? error.message : error
    );
    // Return empty events if table doesn't exist yet
    events = [];
  }

  // Fetch available resources for linking (all published content)
  const [pages, slides, assignments] = await Promise.all([
    getPrisma().page.findMany({
      where: { classroom_id: classroom.id, is_draft: false },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
    }),
    getPrisma().slide.findMany({
      where: { classroom_id: classroom.id, is_draft: false },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
    }),
    getPrisma().assignment.findMany({
      where: { repository: { classroom_id: classroom.id }, is_published: true },
      select: { id: true, title: true, repository: { select: { title: true, slug: true } } },
      orderBy: { title: 'asc' },
    }),
  ]);

  // Build subscription URL
  const subscriptionUrl = buildCalendarUrl(classSlug);

  return data({
    events,
    userId,
    role,
    isAdmin,
    canEdit: ['OWNER', 'TEACHER', 'ASSISTANT'].includes(role),
    currentYear: year,
    currentMonth: month,
    subscriptionUrl,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    pages,
    slides,
    assignments,
  });
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { class: classSlug } = params;
  invariant(classSlug, 'Classroom is required');

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'CALENDAR',
    attemptedAction: 'modify',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const isAdmin = ['OWNER', 'TEACHER'].includes(membership!.role);

  // Every branch below records an audit row once its write has landed, using
  // the classroom and role this request was authorized with. Events use the
  // MCP calendar tools' resource_type ('CALENDAR'); the deadline branch mutates
  // an Assignment, so it uses theirs ('ASSIGNMENT'). `tool` names the intent —
  // the audit service dedups on it, so editing an event and then deleting it
  // inside the same few seconds stays two rows.
  const audit = (
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>
  ) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action,
      resourceType,
      resourceId,
      metadata,
    });

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'create') {
    const eventData = JSON.parse(formData.get('eventData') as string);
    const { linkedPageIds, linkedSlideIds, linkedAssignmentIds, ...createData } = eventData;

    // Assistants may only add office hours. The sibling /assistant variant of
    // this page enforces that, but the gate above admits ASSISTANT here too and
    // this branch is reached by POSTing to this URL — so without this check the
    // restriction is keyed on which URL the client chose, not on the caller's
    // role. `isAdmin` already guards update/delete/update_deadline below;
    // create was the one branch that skipped it, and it is the branch where the
    // policy actually applies.
    if (!isAdmin && createData.event_type !== 'OFFICE_HOURS') {
      return data(
        { success: false, error: 'Assistants can only create Office Hours events' },
        { status: 403 }
      );
    }

    const newEvent = await ClassmojiService.calendar.createEvent(classroom.id, userId, createData);

    // If links were provided (non-recurring events only), add them
    const hasLinks = linkedPageIds?.length || linkedSlideIds?.length || linkedAssignmentIds?.length;
    if (hasLinks) {
      await ClassmojiService.calendar.updateEventLinks(
        newEvent.id,
        classroom.id,
        {
          pageIds: linkedPageIds || [],
          slideIds: linkedSlideIds || [],
          assignmentIds: linkedAssignmentIds || [],
        },
        null
      ); // null occurrence_date for non-recurring events
    }

    await audit('CREATE', 'CALENDAR', newEvent.id, {
      tool: 'web:calendar.create_event',
      title: createData.title ?? null,
      event_type: createData.event_type ?? null,
      is_recurring: Boolean(createData.recurrence_rule),
      linked: hasLinks
        ? {
            pages: linkedPageIds?.length ?? 0,
            slides: linkedSlideIds?.length ?? 0,
            assignments: linkedAssignmentIds?.length ?? 0,
          }
        : null,
    });

    return data({ success: true });
  }

  if (intent === 'update') {
    const eventId = formData.get('eventId') as string;
    const eventData = JSON.parse(formData.get('eventData') as string);

    const event = await ClassmojiService.calendar.getEventById(eventId);

    // Event must exist and belong to THIS classroom. The role check above only
    // proves the caller is staff in this classroom, not that the target event
    // is in it, so without this a staff member could edit another class's event
    // via a crafted eventId.
    if (!event || event.classroom_id !== classroom.id) {
      return data({ success: false, error: 'Event not found' }, { status: 404 });
    }

    // OWNER/TEACHER can edit any event, ASSISTANT can only edit their own
    if (!isAdmin && String(event.created_by) !== String(userId)) {
      return data(
        { success: false, error: 'Unauthorized - you can only edit your own events' },
        { status: 403 }
      );
    }

    // Handle edit scope for recurring events
    const {
      editScope,
      occurrenceDate,
      linkedPageIds,
      linkedSlideIds,
      linkedAssignmentIds,
      ...updateData
    } = eventData;

    if (editScope && occurrenceDate) {
      await ClassmojiService.calendar.updateEventWithScope(
        eventId as string,
        updateData,
        editScope,
        new Date(occurrenceDate)
      );
    } else {
      await ClassmojiService.calendar.updateEvent(eventId as string, updateData);
    }

    // Handle resource links update (only allowed with 'this_only' scope for recurring events)
    const hasLinkUpdates =
      linkedPageIds !== undefined ||
      linkedSlideIds !== undefined ||
      linkedAssignmentIds !== undefined;
    if (hasLinkUpdates) {
      // For recurring events, only allow link updates with 'this_only' scope
      const linkOccurrenceDate =
        editScope === 'this_only' && occurrenceDate ? new Date(occurrenceDate) : null;

      await ClassmojiService.calendar.updateEventLinks(
        eventId as string,
        classroom.id,
        {
          pageIds: linkedPageIds || [],
          slideIds: linkedSlideIds || [],
          assignmentIds: linkedAssignmentIds || [],
        },
        linkOccurrenceDate
      );
    }

    await audit('UPDATE', 'CALENDAR', eventId, {
      tool: 'web:calendar.update_event',
      // Which fields moved, not their contents — descriptions can be long.
      fields: Object.keys(updateData),
      // A recurring edit changes a different number of occurrences depending on
      // scope, so the scope is part of what was done.
      edit_scope: editScope ?? null,
      occurrence_date: occurrenceDate ?? null,
      links_updated: hasLinkUpdates,
    });

    return data({ success: true });
  }

  if (intent === 'delete') {
    const eventId = formData.get('eventId') as string;
    const deleteOptions = formData.get('deleteOptions') as string | null;
    const options = deleteOptions ? JSON.parse(deleteOptions) : null;

    try {
      const event = await ClassmojiService.calendar.getEventById(eventId);

      // Event must exist and belong to THIS classroom (prevents cross-classroom
      // deletes via a crafted eventId).
      if (!event || event.classroom_id !== classroom.id) {
        return data({ success: false, error: 'Event not found' }, { status: 404 });
      }

      // OWNER/TEACHER can delete any event, ASSISTANT can only delete their own
      if (!isAdmin && String(event.created_by) !== String(userId)) {
        return data(
          { success: false, error: 'Unauthorized - you can only delete your own events' },
          { status: 403 }
        );
      }

      // Handle delete scope for recurring events
      if (options?.editScope && options?.occurrenceDate) {
        await ClassmojiService.calendar.deleteEventWithScope(
          eventId as string,
          options.editScope,
          new Date(options.occurrenceDate)
        );
      } else {
        await ClassmojiService.calendar.deleteEvent(eventId as string);
      }

      await audit('DELETE', 'CALENDAR', eventId, {
        tool: 'web:calendar.delete_event',
        title: event.title,
        // Scope decides whether one occurrence or the whole series went away.
        delete_scope: options?.editScope ?? null,
        occurrence_date: options?.occurrenceDate ?? null,
      });

      return data({ success: true });
    } catch (error: unknown) {
      console.error('Delete event error:', error);
      return data(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'update_deadline') {
    // Only OWNER and TEACHER can move deadlines (not ASSISTANT)
    if (!isAdmin) {
      return data(
        { success: false, error: 'Unauthorized - only teachers can move deadlines' },
        { status: 403 }
      );
    }

    const assignmentId = formData.get('assignmentId') as string;
    const newDeadline = formData.get('newDeadline') as string;

    // Validate the assignment exists and belongs to this classroom
    const assignment = await ClassmojiService.assignment.findById(assignmentId);

    if (!assignment) {
      return data({ success: false, error: 'Assignment not found' }, { status: 404 });
    }

    // Verify assignment belongs to this classroom (through its repository)
    if (assignment.repository.classroom_id !== classroom.id) {
      return data(
        { success: false, error: 'Assignment does not belong to this classroom' },
        { status: 403 }
      );
    }

    const previousDeadline = assignment.student_deadline;

    await ClassmojiService.assignment.update(assignmentId as string, {
      student_deadline: new Date(newDeadline as string),
    });

    // An Assignment, not a CalendarEvent — so this uses the resource_type the
    // MCP assignment tools write, keyed on the assignment id. Both ends of the
    // move are recorded: "the deadline changed" is not a useful audit row.
    await audit('UPDATE', 'ASSIGNMENT', assignmentId, {
      tool: 'web:calendar.update_deadline',
      fields: ['student_deadline'],
      previous_deadline: previousDeadline ? new Date(previousDeadline).toISOString() : null,
      new_deadline: new Date(newDeadline as string).toISOString(),
    });

    return data({ success: true });
  }

  throw new Response('Invalid intent', { status: 400 });
};

// CalendarEvent type used locally - compatible with EditEventModal's CalendarEvent
interface CalendarEventLocal {
  id: string;
  title: string;
  event_type: string;
  start_time: string;
  end_time: string;
  location?: string | null;
  meeting_link?: string | null;
  description?: string | null;
  recurrence_rule?: string | { days?: string[]; until?: string | null } | null;
  created_by: number | string;
  is_recurring?: boolean;
  is_deadline?: boolean;
  occurrence_date?: string | null;
  [key: string]: unknown;
}

const AdminCalendar = ({ loaderData }: Route.ComponentProps) => {
  const {
    events: initialEvents,
    userId,
    canEdit,
    isAdmin,
    subscriptionUrl,
    slidesUrl,
    pagesUrl,
    pages,
    slides,
    assignments,
  } = loaderData;
  const { class: classSlug } = useParams();
  const fetcher = useFetcher();
  const eventsFetcher = useFetcher();
  const callout = useCallout();
  // Resource links point back into the route tree the user is already in. This
  // route is served under every prefix its loader and action allow (/admin and
  // /teacher), so the prefix is read off the URL rather than hardcoded.
  const rolePrefix = useLocation().pathname.split('/')[1];

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addEventDefaults, setAddEventDefaults] = useState<AddEventDefaults | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [optimisticEvents, setOptimisticEvents] = useState<CalendarEventLocal[] | null>(null);

  // Track current view month/year for refreshing after mutations
  const today = new Date();
  const [currentViewYear, setCurrentViewYear] = useState(today.getFullYear());
  const [currentViewMonth, setCurrentViewMonth] = useState(today.getMonth());

  // Use optimistic events if available, then fetched, then initial loader events
  const events = optimisticEvents || eventsFetcher.data?.events || initialEvents;

  const loading = fetcher.state !== 'idle';

  // Handle month navigation - fetch new events
  const handleMonthChange = (year: number, month: number) => {
    setCurrentViewYear(year);
    setCurrentViewMonth(month);
    eventsFetcher.load(`?year=${year}&month=${month}`);
  };

  // Close modals and show toast when fetcher completes
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        setOptimisticEvents(null); // Clear optimistic state, let fresh data take over
        setAddModalOpen(false);
        setAddEventDefaults(null);
        setEditModalOpen(false);
        setSelectedEvent(null);
        // Refresh events for current view month after mutation
        eventsFetcher.load(`?year=${currentViewYear}&month=${currentViewMonth}`);
      } else if (fetcher.data.error) {
        setOptimisticEvents(null); // Revert on error
        callout.show({ variant: 'error', title: fetcher.data.error });
      }
    }
  }, [fetcher.data, fetcher.state]);

  const handleAddEvent = (eventData: Record<string, unknown>) => {
    const formData = new FormData();
    formData.append('intent', 'create');
    formData.append('eventData', JSON.stringify(eventData));

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleUpdateEvent = (eventData: EventFormData) => {
    const formData = new FormData();
    formData.append('intent', 'update');
    formData.append('eventId', selectedEvent!.id!);
    formData.append('eventData', JSON.stringify(eventData));

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleDeleteEvent = (
    eventId: string,
    options: { editScope?: string; occurrenceDate?: string } | null = null
  ) => {
    const formData = new FormData();
    formData.append('intent', 'delete');
    formData.append('eventId', eventId);
    if (options) {
      formData.append('deleteOptions', JSON.stringify(options));
    }

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleEventDrop = (event: CalendarEvent, newStartTime: Date, newEndTime: Date) => {
    // OWNER/TEACHER can drag any event, others can only drag their own.
    // IDs are UUID strings, so compare as strings (Number(uuid) is NaN, which
    // would make this always false and block users from moving their own events).
    const canDragEvent = isAdmin || String(event.created_by) === String(userId);

    if (!canDragEvent) {
      callout.show({ variant: 'error', title: 'You can only move your own events' });
      return;
    }

    // Optimistically update events immediately for smooth UI
    const updatedEvents = events.map((e: CalendarEventLocal) => {
      const isSameEvent =
        e.id === event.id &&
        ((!e.occurrence_date && !event.occurrence_date) ||
          (e.occurrence_date &&
            event.occurrence_date &&
            new Date(e.occurrence_date).getTime() === new Date(event.occurrence_date).getTime()));

      if (isSameEvent) {
        return {
          ...e,
          start_time: newStartTime.toISOString(),
          end_time: newEndTime.toISOString(),
        };
      }
      return e;
    });
    setOptimisticEvents(updatedEvents);

    const eventData = {
      title: event.title,
      event_type: event.event_type,
      start_time: newStartTime.toISOString(),
      end_time: newEndTime.toISOString(),
      location: event.location,
      meeting_link: event.meeting_link,
      description: event.description,
      recurrence_rule: event.recurrence_rule,
    };

    // For recurring event occurrences, only move this single occurrence
    const eventPayload: Record<string, unknown> = { ...eventData };
    if (event.is_recurring && event.occurrence_date) {
      eventPayload.editScope = 'this_only';
      eventPayload.occurrenceDate = event.occurrence_date;
    }

    const formData = new FormData();
    formData.append('intent', 'update');
    formData.append('eventId', event.id!);
    formData.append('eventData', JSON.stringify(eventPayload));

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleDeadlineDrop = (deadline: CalendarEvent, newDateTime: Date) => {
    // Form-close items are deadlines too, but there is no assignment behind them
    // and the id below would not parse. CourseCalendar already refuses to drag
    // them; this is the second lock.
    if (deadline.is_form_close) return;

    // Extract assignment ID from deadline event ID (format: 'deadline-{assignment.id}')
    const assignmentId = deadline.id!.replace('deadline-', '');

    // Optimistically update events immediately for smooth UI
    const updatedEvents = events.map((e: CalendarEventLocal) => {
      if (e.id === deadline.id) {
        return {
          ...e,
          start_time: newDateTime.toISOString(),
          end_time: newDateTime.toISOString(),
        };
      }
      return e;
    });
    setOptimisticEvents(updatedEvents);

    const formData = new FormData();
    formData.append('intent', 'update_deadline');
    formData.append('assignmentId', assignmentId);
    formData.append('newDeadline', newDateTime.toISOString());

    fetcher.submit(formData, { method: 'POST' });
  };

  // Drag-selected time range on the week view → open the add modal prefilled.
  const handleRangeSelect = (start: Date, end: Date) => {
    setAddEventDefaults({
      date: dayjs(start),
      start_time: dayjs(start),
      end_time: dayjs(end),
    });
    setAddModalOpen(true);
  };

  const handleEventClick = (event: CalendarEvent) => {
    // OWNER/TEACHER can edit any event, others can only edit their own.
    // IDs are UUID strings, so compare as strings (Number(uuid) is NaN).
    const canEditEvent = isAdmin || String(event.created_by) === String(userId);

    if (event.is_deadline) {
      // Deadlines are read-only, just show info
      setSelectedEvent(event);
      setViewModalOpen(true);
    } else if (canEdit && canEditEvent) {
      // User can edit this event
      setSelectedEvent(event);
      setEditModalOpen(true);
    } else {
      // Just view the event
      setSelectedEvent(event);
      setViewModalOpen(true);
    }
  };

  return (
    <div className="min-h-full">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Calendar</h1>
        <div className="flex gap-2">
          <span data-tour="calendar-subscribe">
            <CalendarSubscriptionCard subscriptionUrl={subscriptionUrl} />
          </span>
          {canEdit && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setAddEventDefaults(null);
                setAddModalOpen(true);
              }}
              data-tour="calendar-add-event"
            >
              Add Event
            </Button>
          )}
        </div>
      </div>

      <CourseCalendar
        events={events}
        onEventClick={handleEventClick}
        onEventDrop={canEdit ? handleEventDrop : null}
        onDeadlineDrop={isAdmin ? handleDeadlineDrop : null}
        canDragDeadlines={isAdmin}
        onMonthChange={handleMonthChange}
        onRangeSelect={canEdit ? handleRangeSelect : null}
        showCreator={true}
      />

      {canEdit && (
        <>
          <AddEventModal
            open={addModalOpen}
            onClose={() => {
              setAddModalOpen(false);
              setAddEventDefaults(null);
            }}
            onSubmit={handleAddEvent}
            loading={loading}
            pages={pages}
            slides={slides}
            assignments={assignments}
            defaultValues={addEventDefaults}
          />

          <EditEventModal
            open={editModalOpen}
            event={
              selectedEvent as Record<string, unknown> as Parameters<
                typeof EditEventModal
              >[0]['event']
            }
            onClose={() => {
              setEditModalOpen(false);
              setSelectedEvent(null);
            }}
            onSubmit={handleUpdateEvent as Parameters<typeof EditEventModal>[0]['onSubmit']}
            onDelete={handleDeleteEvent as Parameters<typeof EditEventModal>[0]['onDelete']}
            loading={loading}
            classSlug={classSlug!}
            rolePrefix={rolePrefix}
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
            pages={pages}
            slides={slides}
            assignments={assignments}
          />
        </>
      )}

      <Modal
        title="Event Details"
        open={viewModalOpen}
        onCancel={() => {
          setViewModalOpen(false);
          setSelectedEvent(null);
        }}
        footer={null}
      >
        {selectedEvent && (
          <>
            <EventCard event={selectedEvent} showCreator={true} compact={false} />
            <EventLinks
              event={selectedEvent}
              classSlug={classSlug}
              rolePrefix={rolePrefix}
              slidesUrl={slidesUrl}
              pagesUrl={pagesUrl}
            />
          </>
        )}
      </Modal>
    </div>
  );
};

export default AdminCalendar;
