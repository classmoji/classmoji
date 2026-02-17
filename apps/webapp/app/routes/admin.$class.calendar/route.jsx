import { useState, useEffect } from 'react';
import { Button, Modal } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import invariant from 'tiny-invariant';
import { data, useFetcher, useParams } from 'react-router';
import { toast } from 'react-toastify';
import { PageHeader } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import prisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/helpers';
import { buildCalendarUrl, getCalendarDateRange } from '~/utils/calendar.server';
import CourseCalendar from '~/components/features/calendar/CourseCalendar';
import CalendarSubscriptionCard from '~/components/features/calendar/CalendarSubscriptionCard';
import AddEventModal from '~/components/features/calendar/AddEventModal';
import EditEventModal from '~/components/features/calendar/EditEventModal';
import EventCard from '~/components/features/calendar/EventCard';
import EventLinks from '~/components/features/calendar/EventLinks';

export const loader = async ({ request, params }) => {
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

  let events = [];
  try {
    // Pass includeRawLinks=true for admin UI editing, includeUnpublished=true to see draft assignments
    events = await ClassmojiService.calendar.getClassroomCalendar(
      classroom.id,
      start,
      end,
      null, // userId not needed for admin
      true, // includeRawLinks for editing UI
      true  // includeUnpublished to see draft/unpublished assignments
    );
  } catch (error) {
    console.error('Calendar service error (likely missing migration):', error.message);
    // Return empty events if table doesn't exist yet
    events = [];
  }

  // Fetch available resources for linking (all published content)
  const [pages, slides, assignments] = await Promise.all([
    prisma.page.findMany({
      where: { classroom_id: classroom.id, is_draft: false },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
    }),
    prisma.slide.findMany({
      where: { classroom_id: classroom.id, is_draft: false },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
    }),
    prisma.assignment.findMany({
      where: { module: { classroom_id: classroom.id }, is_published: true },
      select: { id: true, title: true, module: { select: { title: true, slug: true } } },
      orderBy: { title: 'asc' },
    }),
  ]);

  const role = membership.role;
  const isAdmin = ['OWNER', 'TEACHER'].includes(role);

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

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;
  invariant(classSlug, 'Classroom is required');

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'CALENDAR',
    attemptedAction: 'modify',
  });

  const isAdmin = ['OWNER', 'TEACHER'].includes(membership.role);

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'create') {
    const eventData = JSON.parse(formData.get('eventData'));
    const { linkedPageIds, linkedSlideIds, linkedAssignmentIds, ...createData } = eventData;

    const newEvent = await ClassmojiService.calendar.createEvent(classroom.id, userId, createData);

    // If links were provided (non-recurring events only), add them
    const hasLinks = linkedPageIds?.length || linkedSlideIds?.length || linkedAssignmentIds?.length;
    if (hasLinks) {
      await ClassmojiService.calendar.updateEventLinks(newEvent.id, classroom.id, {
        pageIds: linkedPageIds || [],
        slideIds: linkedSlideIds || [],
        assignmentIds: linkedAssignmentIds || [],
      }, null); // null occurrence_date for non-recurring events
    }

    return data({ success: true });
  }

  if (intent === 'update') {
    const eventId = formData.get('eventId');
    const eventData = JSON.parse(formData.get('eventData'));

    const event = await ClassmojiService.calendar.getEventById(eventId);

    // OWNER/TEACHER can edit any event, ASSISTANT can only edit their own
    if (!isAdmin && String(event.created_by) !== String(userId)) {
      return data(
        { success: false, error: 'Unauthorized - you can only edit your own events' },
        { status: 403 }
      );
    }

    // Handle edit scope for recurring events
    const { editScope, occurrenceDate, linkedPageIds, linkedSlideIds, linkedAssignmentIds, ...updateData } = eventData;

    if (editScope && occurrenceDate) {
      await ClassmojiService.calendar.updateEventWithScope(
        eventId,
        updateData,
        editScope,
        new Date(occurrenceDate)
      );
    } else {
      await ClassmojiService.calendar.updateEvent(eventId, updateData);
    }

    // Handle resource links update (only allowed with 'this_only' scope for recurring events)
    const hasLinkUpdates = linkedPageIds !== undefined || linkedSlideIds !== undefined || linkedAssignmentIds !== undefined;
    if (hasLinkUpdates) {
      // For recurring events, only allow link updates with 'this_only' scope
      const linkOccurrenceDate = editScope === 'this_only' && occurrenceDate
        ? new Date(occurrenceDate)
        : null;

      await ClassmojiService.calendar.updateEventLinks(eventId, classroom.id, {
        pageIds: linkedPageIds || [],
        slideIds: linkedSlideIds || [],
        assignmentIds: linkedAssignmentIds || [],
      }, linkOccurrenceDate);
    }

    return data({ success: true });
  }

  if (intent === 'delete') {
    const eventId = formData.get('eventId');
    const deleteOptions = formData.get('deleteOptions');
    const options = deleteOptions ? JSON.parse(deleteOptions) : null;

    try {
      const event = await ClassmojiService.calendar.getEventById(eventId);

      if (!event) {
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
          eventId,
          options.editScope,
          new Date(options.occurrenceDate)
        );
      } else {
        await ClassmojiService.calendar.deleteEvent(eventId);
      }

      return data({ success: true });
    } catch (error) {
      console.error('Delete event error:', error);
      return data({ success: false, error: error.message }, { status: 500 });
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

    const assignmentId = formData.get('assignmentId');
    const newDeadline = formData.get('newDeadline');

    // Validate the assignment exists and belongs to this classroom
    const assignment = await ClassmojiService.assignment.findById(assignmentId);

    if (!assignment) {
      return data({ success: false, error: 'Assignment not found' }, { status: 404 });
    }

    // Verify assignment belongs to this classroom (through its module)
    if (assignment.module.classroom_id !== classroom.id) {
      return data(
        { success: false, error: 'Assignment does not belong to this classroom' },
        { status: 403 }
      );
    }

    await ClassmojiService.assignment.update(assignmentId, {
      student_deadline: new Date(newDeadline),
    });

    return data({ success: true });
  }

  throw new Response('Invalid intent', { status: 400 });
};

const AdminCalendar = ({ loaderData }) => {
  const { events: initialEvents, userId, canEdit, isAdmin, subscriptionUrl, slidesUrl, pagesUrl, pages, slides, assignments } = loaderData;
  const { class: classSlug } = useParams();
  const fetcher = useFetcher();
  const eventsFetcher = useFetcher();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [optimisticEvents, setOptimisticEvents] = useState(null);

  // Track current view month/year for refreshing after mutations
  const today = new Date();
  const [currentViewYear, setCurrentViewYear] = useState(today.getFullYear());
  const [currentViewMonth, setCurrentViewMonth] = useState(today.getMonth());

  // Use optimistic events if available, then fetched, then initial loader events
  const events = optimisticEvents || eventsFetcher.data?.events || initialEvents;

  const loading = fetcher.state !== 'idle';

  // Handle month navigation - fetch new events
  const handleMonthChange = (year, month) => {
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
        setEditModalOpen(false);
        setSelectedEvent(null);
        // Refresh events for current view month after mutation
        eventsFetcher.load(`?year=${currentViewYear}&month=${currentViewMonth}`);
      } else if (fetcher.data.error) {
        setOptimisticEvents(null); // Revert on error
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.data, fetcher.state]);

  const handleAddEvent = eventData => {
    const formData = new FormData();
    formData.append('intent', 'create');
    formData.append('eventData', JSON.stringify(eventData));

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleUpdateEvent = eventData => {
    const formData = new FormData();
    formData.append('intent', 'update');
    formData.append('eventId', selectedEvent.id);
    formData.append('eventData', JSON.stringify(eventData));

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleDeleteEvent = (eventId, options = null) => {
    const formData = new FormData();
    formData.append('intent', 'delete');
    formData.append('eventId', eventId);
    if (options) {
      formData.append('deleteOptions', JSON.stringify(options));
    }

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleEventDrop = (event, newStartTime, newEndTime) => {
    // OWNER/TEACHER can drag any event, others can only drag their own
    const canDragEvent = isAdmin || Number(event.created_by) === Number(userId);

    if (!canDragEvent) {
      toast.error('You can only move your own events');
      return;
    }

    // Optimistically update events immediately for smooth UI
    const updatedEvents = events.map(e => {
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
    if (event.is_recurring && event.occurrence_date) {
      eventData.editScope = 'this_only';
      eventData.occurrenceDate = event.occurrence_date;
    }

    const formData = new FormData();
    formData.append('intent', 'update');
    formData.append('eventId', event.id);
    formData.append('eventData', JSON.stringify(eventData));

    fetcher.submit(formData, { method: 'POST' });
  };

  const handleDeadlineDrop = (deadline, newDateTime) => {
    // Extract assignment ID from deadline event ID (format: 'deadline-{assignment.id}')
    const assignmentId = deadline.id.replace('deadline-', '');

    // Optimistically update events immediately for smooth UI
    const updatedEvents = events.map(e => {
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

  const handleEventClick = event => {
    // Convert both to numbers for comparison (handle string/number mismatch)
    const eventOwnerId = Number(event.created_by);
    const currentUserId = Number(userId);

    // OWNER/TEACHER can edit any event, others can only edit their own
    const canEditEvent = isAdmin || eventOwnerId === currentUserId;

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
    <div>
      <PageHeader title="Calendar" routeName="calendar">
        <div className="flex gap-2">
          <CalendarSubscriptionCard subscriptionUrl={subscriptionUrl} />
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
              Add Event
            </Button>
          )}
        </div>
      </PageHeader>

      <CourseCalendar
        events={events}
        onEventClick={handleEventClick}
        onEventDrop={canEdit ? handleEventDrop : null}
        onDeadlineDrop={isAdmin ? handleDeadlineDrop : null}
        canDragDeadlines={isAdmin}
        onMonthChange={handleMonthChange}
        showCreator={true}
      />

      {canEdit && (
        <>
          <AddEventModal
            open={addModalOpen}
            onClose={() => setAddModalOpen(false)}
            onSubmit={handleAddEvent}
            loading={loading}
            pages={pages}
            slides={slides}
            assignments={assignments}
          />

          <EditEventModal
            open={editModalOpen}
            event={selectedEvent}
            onClose={() => {
              setEditModalOpen(false);
              setSelectedEvent(null);
            }}
            onSubmit={handleUpdateEvent}
            onDelete={handleDeleteEvent}
            loading={loading}
            classSlug={classSlug}
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
              rolePrefix="admin"
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
