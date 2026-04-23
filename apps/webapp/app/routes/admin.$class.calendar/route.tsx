import { useEffect, useState } from 'react';
import invariant from 'tiny-invariant';
import { data, useFetcher, useParams, useSearchParams } from 'react-router';
import { toast } from 'react-toastify';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/helpers';
import { buildCalendarUrl, getCalendarDateRange } from '~/utils/calendar.server';
import { CalendarScreen } from '~/components/features/calendar';
import type { CalendarEvent } from '~/components/features/calendar';
import { mapClassroomCalendarToEvents } from '~/components/features/calendar/mapToCalendarEvents';
import AddEventModal from '~/components/features/calendar/AddEventModal';
import EditEventModal, {
  type EventFormData,
} from '~/components/features/calendar/EditEventModal';

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

  const url = new URL(request.url);
  const yearParam = url.searchParams.get('year');
  const monthParam = url.searchParams.get('month');

  const today = new Date();
  const year = yearParam ? parseInt(yearParam, 10) : today.getFullYear();
  const month = monthParam ? parseInt(monthParam, 10) : today.getMonth();

  const { start, end } = getCalendarDateRange(year, month);

  let rawEvents: Awaited<ReturnType<typeof ClassmojiService.calendar.getClassroomCalendar>> = [];
  try {
    rawEvents = await ClassmojiService.calendar.getClassroomCalendar(
      classroom.id,
      start,
      end,
      null,
      true, // includeRawLinks for editing UI
      true // includeUnpublished so draft content still shows
    );
  } catch (error: unknown) {
    console.error(
      'Calendar service error (likely missing migration):',
      error instanceof Error ? error.message : error
    );
    rawEvents = [];
  }

  const events: CalendarEvent[] = mapClassroomCalendarToEvents(rawEvents, {
    classSlug,
    rolePrefix: 'admin',
  });

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
      where: { module: { classroom_id: classroom.id }, is_published: true },
      select: { id: true, title: true, module: { select: { title: true, slug: true } } },
      orderBy: { title: 'asc' },
    }),
  ]);

  const role = membership!.role;
  const isAdmin = ['OWNER', 'TEACHER'].includes(role);
  const subscribeUrl = buildCalendarUrl(classSlug);

  return data({
    year,
    month,
    events,
    rawEvents,
    subscribeUrl,
    userId,
    isAdmin,
    canEdit: ['OWNER', 'TEACHER', 'ASSISTANT'].includes(role),
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

  const isAdmin = ['OWNER', 'TEACHER'].includes(membership!.role);

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'create') {
    const eventData = JSON.parse(formData.get('eventData') as string);
    const { linkedPageIds, linkedSlideIds, linkedAssignmentIds, ...createData } = eventData;

    const newEvent = await ClassmojiService.calendar.createEvent(classroom.id, userId, createData);

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
      );
    }

    return data({ success: true });
  }

  if (intent === 'update') {
    const eventId = formData.get('eventId') as string;
    const eventData = JSON.parse(formData.get('eventData') as string);

    const event = await ClassmojiService.calendar.getEventById(eventId);

    if (!isAdmin && String(event!.created_by) !== String(userId)) {
      return data(
        { success: false, error: 'Unauthorized - you can only edit your own events' },
        { status: 403 }
      );
    }

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
        eventId,
        updateData,
        editScope,
        new Date(occurrenceDate)
      );
    } else {
      await ClassmojiService.calendar.updateEvent(eventId, updateData);
    }

    const hasLinkUpdates =
      linkedPageIds !== undefined ||
      linkedSlideIds !== undefined ||
      linkedAssignmentIds !== undefined;
    if (hasLinkUpdates) {
      const linkOccurrenceDate =
        editScope === 'this_only' && occurrenceDate ? new Date(occurrenceDate) : null;

      await ClassmojiService.calendar.updateEventLinks(
        eventId,
        classroom.id,
        {
          pageIds: linkedPageIds || [],
          slideIds: linkedSlideIds || [],
          assignmentIds: linkedAssignmentIds || [],
        },
        linkOccurrenceDate
      );
    }

    return data({ success: true });
  }

  if (intent === 'delete') {
    const eventId = formData.get('eventId') as string;
    const deleteOptions = formData.get('deleteOptions') as string | null;
    const options = deleteOptions ? JSON.parse(deleteOptions) : null;

    try {
      const event = await ClassmojiService.calendar.getEventById(eventId);

      if (!event) {
        return data({ success: false, error: 'Event not found' }, { status: 404 });
      }

      if (!isAdmin && String(event.created_by) !== String(userId)) {
        return data(
          { success: false, error: 'Unauthorized - you can only delete your own events' },
          { status: 403 }
        );
      }

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
    } catch (error: unknown) {
      console.error('Delete event error:', error);
      return data(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'update_deadline') {
    if (!isAdmin) {
      return data(
        { success: false, error: 'Unauthorized - only teachers can move deadlines' },
        { status: 403 }
      );
    }

    const assignmentId = formData.get('assignmentId') as string;
    const newDeadline = formData.get('newDeadline') as string;

    const assignment = await ClassmojiService.assignment.findById(assignmentId);

    if (!assignment) {
      return data({ success: false, error: 'Assignment not found' }, { status: 404 });
    }

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

const AdminCalendar = ({ loaderData }: Route.ComponentProps) => {
  const {
    year,
    month,
    events,
    rawEvents,
    subscribeUrl,
    userId,
    isAdmin,
    canEdit,
    slidesUrl,
    pagesUrl,
    pages,
    slides,
    assignments,
  } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [selectedRaw, setSelectedRaw] = useState<Record<string, unknown> | null>(null);

  const { class: classSlug } = useParams();

  const loading = fetcher.state !== 'idle';

  const goToMonth = (y: number, m: number) => {
    const date = new Date(y, m, 1);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('year', String(date.getFullYear()));
    nextParams.set('month', String(date.getMonth()));
    setSearchParams(nextParams, { preventScrollReset: true });
  };

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        setAddOpen(false);
        setEditOpen(false);
        setSelectedRaw(null);
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.data, fetcher.state]);

  const handleEventClick = (ev: CalendarEvent) => {
    if (!canEdit || ev.isDeadline || !ev.id) return;
    // Find matching raw event (same id, and same occurrence if recurring)
    const raw = (rawEvents as Array<Record<string, unknown>>).find((r) => {
      if (r.id !== ev.id) return false;
      if (ev.isRecurring) {
        const occ = r.occurrence_date;
        if (!occ) return false;
        const d = occ instanceof Date ? occ : new Date(occ as string);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate()
        ).padStart(2, '0')}`;
        return dateStr === ev.date;
      }
      return true;
    });
    if (!raw) return;
    const ownerId = Number(raw.created_by);
    const canEditEvent = isAdmin || ownerId === Number(userId);
    if (!canEditEvent) {
      toast.error('You can only edit your own events');
      return;
    }
    setSelectedRaw(raw);
    setEditOpen(true);
  };

  const handleAdd = (eventData: Record<string, unknown>) => {
    const fd = new FormData();
    fd.append('intent', 'create');
    fd.append('eventData', JSON.stringify(eventData));
    fetcher.submit(fd, { method: 'POST' });
  };

  const handleUpdate = async (eventData: EventFormData) => {
    if (!selectedRaw?.id) return;
    const fd = new FormData();
    fd.append('intent', 'update');
    fd.append('eventId', String(selectedRaw.id));
    fd.append('eventData', JSON.stringify(eventData));
    fetcher.submit(fd, { method: 'POST' });
  };

  const handleDelete = async (
    id: string,
    options?: Record<string, unknown>
  ) => {
    const fd = new FormData();
    fd.append('intent', 'delete');
    fd.append('eventId', id);
    if (options) fd.append('deleteOptions', JSON.stringify(options));
    fetcher.submit(fd, { method: 'POST' });
  };

  return (
    <>
      <CalendarScreen
        year={year}
        month={month}
        events={events}
        subscribeUrl={subscribeUrl}
        onPrev={() => goToMonth(year, month - 1)}
        onNext={() => goToMonth(year, month + 1)}
        onToday={() => {
          const today = new Date();
          goToMonth(today.getFullYear(), today.getMonth());
        }}
        onEventClick={canEdit ? handleEventClick : undefined}
        headerActions={
          canEdit ? (
            <button
              type="button"
              className="btn cm-btn-primary"
              onClick={() => setAddOpen(true)}
            >
              + Add event
            </button>
          ) : null
        }
      />

      {canEdit && (
        <>
          <AddEventModal
            open={addOpen}
            onClose={() => setAddOpen(false)}
            onSubmit={handleAdd}
            loading={loading}
            pages={pages}
            slides={slides}
            assignments={assignments}
          />

          <EditEventModal
            open={editOpen}
            event={
              selectedRaw as Record<string, unknown> as Parameters<
                typeof EditEventModal
              >[0]['event']
            }
            onClose={() => {
              setEditOpen(false);
              setSelectedRaw(null);
            }}
            onSubmit={handleUpdate as Parameters<typeof EditEventModal>[0]['onSubmit']}
            onDelete={handleDelete as Parameters<typeof EditEventModal>[0]['onDelete']}
            loading={loading}
            classSlug={classSlug!}
            rolePrefix="admin"
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
            pages={pages}
            slides={slides}
            assignments={assignments}
          />
        </>
      )}
    </>
  );
};

export default AdminCalendar;
