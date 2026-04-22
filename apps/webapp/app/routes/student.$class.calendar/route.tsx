import invariant from 'tiny-invariant';
import { data, useSearchParams } from 'react-router';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { buildCalendarUrl, getCalendarDateRange } from '~/utils/calendar.server';
import { CalendarScreen } from '~/components/features/calendar';
import type { CalendarEvent } from '~/components/features/calendar';
import { mapClassroomCalendarToEvents } from '~/components/features/calendar/mapToCalendarEvents';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  invariant(classSlug, 'Classroom is required');

  const { userId } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'CALENDAR',
    attemptedAction: 'view',
  });

  const classroom = await ClassmojiService.classroom.findBySlug(classSlug);

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
      classroom!.id,
      start,
      end,
      userId
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
    rolePrefix: 'student',
  });

  const subscribeUrl = buildCalendarUrl(classSlug);

  return data({
    year,
    month,
    events,
    subscribeUrl,
  });
};

const StudentCalendar = ({ loaderData }: Route.ComponentProps) => {
  const { year, month, events, subscribeUrl } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const goToMonth = (y: number, m: number) => {
    // Normalize month (handles -1 / 12 rollover)
    const date = new Date(y, m, 1);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('year', String(date.getFullYear()));
    nextParams.set('month', String(date.getMonth()));
    setSearchParams(nextParams, { preventScrollReset: true });
  };

  return (
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
    />
  );
};

export default StudentCalendar;
