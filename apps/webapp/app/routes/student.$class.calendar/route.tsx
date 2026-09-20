import { useState } from 'react';
import { Modal } from 'antd';
import invariant from 'tiny-invariant';
import { data, useFetcher, useParams } from 'react-router';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { buildCalendarUrl, getCalendarDateRange } from '~/utils/calendar.server';
import CalendarSubscriptionCard from '~/components/features/calendar/CalendarSubscriptionCard';
import EventCard from '~/components/features/calendar/EventCard';
import EventLinks from '~/components/features/calendar/EventLinks';
import type { CalendarEventWithLinks } from '~/components/features/calendar/types';
import StudentCalendarView from '~/components/features/calendar/StudentCalendarView';

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

  // findBySlug already includes git_organization
  const classroom = await ClassmojiService.classroom.findBySlug(classSlug);

  // Check for date params in URL (for fetching specific month)
  const url = new URL(request.url);
  const yearParam = url.searchParams.get('year');
  const monthParam = url.searchParams.get('month');

  const today = new Date();
  const year = yearParam ? parseInt(yearParam) : today.getFullYear();
  const month = monthParam ? parseInt(monthParam) : today.getMonth();

  const { start, end } = getCalendarDateRange(year, month);

  let events: Awaited<ReturnType<typeof ClassmojiService.calendar.getClassroomCalendar>> = [];
  try {
    // Pass userId to include GitHub issue links for deadlines. Everything
    // after it stays at its default, which IS the student view: no raw link
    // rows, no unpublished assignment deadlines, and no draft pages/decks or
    // links to unpublished assignments (`canSeeDrafts`).
    events = await ClassmojiService.calendar.getClassroomCalendar(
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
    events = [];
  }

  // The reader's own repository assignments, which turn a linked assignment
  // into a link to THEIR GitHub issue.
  const repoAssignments = await ClassmojiService.gitRepoAssignment.findForUser({
    git_repo: { student_id: userId, classroom_id: classroom!.id },
  });

  // Built field by field rather than by handing the row over. `findForUser`
  // returns the whole graph — grades, graders, token transactions, the
  // classroom, the student — and the calendar reads exactly two things off it:
  // the issue number and the repository's name. Spreading the row put all the
  // rest into the page's payload for anyone who opened the network tab.
  const repoAssignmentsByAssignmentId: Record<
    string,
    { provider_issue_number: number; git_repo: { name: string } }
  > = {};
  repoAssignments.forEach(ra => {
    repoAssignmentsByAssignmentId[ra.assignment_id] = {
      provider_issue_number: ra.provider_issue_number,
      git_repo: { name: ra.git_repo.name },
    };
  });

  // Build subscription URL
  const subscriptionUrl = buildCalendarUrl(classSlug);

  return data({
    events,
    subscriptionUrl,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    gitOrgLogin: classroom!.git_organization?.login || null,
    repoAssignmentsByAssignmentId,
  });
};

const StudentCalendar = ({ loaderData }: Route.ComponentProps) => {
  const {
    events: initialEvents,
    subscriptionUrl,
    slidesUrl,
    pagesUrl,
    gitOrgLogin,
    repoAssignmentsByAssignmentId,
  } = loaderData;
  const { class: classSlug } = useParams();
  const eventsFetcher = useFetcher();
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventWithLinks | null>(null);

  // Use fetched events if available, otherwise use initial loader events
  const events = eventsFetcher.data?.events || initialEvents;

  // Handle month navigation - fetch new events
  const handleMonthChange = (year: number, month: number) => {
    eventsFetcher.load(`?year=${year}&month=${month}`);
  };

  const handleEventClick = (event: CalendarEventWithLinks) => {
    setSelectedEvent(event);
    setViewModalOpen(true);
  };

  return (
    <div className="min-h-full">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Calendar</h1>
        <span data-tour="calendar-subscribe">
          <CalendarSubscriptionCard subscriptionUrl={subscriptionUrl} />
        </span>
      </div>

      <div>
        <StudentCalendarView
          events={events}
          onEventClick={handleEventClick}
          onMonthChange={handleMonthChange}
          classSlug={classSlug}
          pagesUrl={pagesUrl}
          slidesUrl={slidesUrl}
          gitOrgLogin={gitOrgLogin}
          repoAssignmentsByAssignmentId={repoAssignmentsByAssignmentId}
        />
      </div>

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
              rolePrefix="student"
              slidesUrl={slidesUrl}
              pagesUrl={pagesUrl}
              gitOrgLogin={gitOrgLogin}
              repoAssignmentsByAssignmentId={repoAssignmentsByAssignmentId}
            />
          </>
        )}
      </Modal>
    </div>
  );
};

export default StudentCalendar;
