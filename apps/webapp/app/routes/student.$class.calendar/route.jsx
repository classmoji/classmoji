import { useState } from 'react';
import { Modal } from 'antd';
import invariant from 'tiny-invariant';
import { data, useFetcher, useParams } from 'react-router';
import { PageHeader } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { buildCalendarUrl, getCalendarDateRange } from '~/utils/calendar.server';
import CourseCalendar from '~/components/features/calendar/CourseCalendar';
import CalendarSubscriptionCard from '~/components/features/calendar/CalendarSubscriptionCard';
import EventCard from '~/components/features/calendar/EventCard';
import EventLinks from '~/components/features/calendar/EventLinks';

export const loader = async ({ request, params }) => {
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

  let events = [];
  try {
    // Pass userId to include GitHub issue links for deadlines
    // Don't include raw links for students (includeRawLinks=false by default)
    events = await ClassmojiService.calendar.getClassroomCalendar(
      classroom.id,
      start,
      end,
      userId
    );
  } catch (error) {
    console.error('Calendar service error (likely missing migration):', error.message);
    events = [];
  }

  // Get user's repository assignments for assignment link navigation
  // This allows linking directly to GitHub issues for assignments
  const repoAssignments = await ClassmojiService.repositoryAssignment.findForUser({
    repository: { student_id: userId, classroom_id: classroom.id },
  });

  // Build map of assignment_id -> repository assignment (with repo info)
  const repoAssignmentsByAssignmentId = {};
  repoAssignments.forEach(ra => {
    repoAssignmentsByAssignmentId[ra.assignment_id] = ra;
  });

  // Build subscription URL
  const subscriptionUrl = buildCalendarUrl(classSlug);

  return data({
    events,
    subscriptionUrl,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    gitOrgLogin: classroom.git_organization?.login || null,
    repoAssignmentsByAssignmentId,
  });
};

const StudentCalendar = ({ loaderData }) => {
  const { events: initialEvents, subscriptionUrl, slidesUrl, pagesUrl, gitOrgLogin, repoAssignmentsByAssignmentId } = loaderData;
  const { class: classSlug } = useParams();
  const eventsFetcher = useFetcher();
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);

  // Use fetched events if available, otherwise use initial loader events
  const events = eventsFetcher.data?.events || initialEvents;

  // Handle month navigation - fetch new events
  const handleMonthChange = (year, month) => {
    eventsFetcher.load(`?year=${year}&month=${month}`);
  };

  const handleEventClick = (event) => {
    setSelectedEvent(event);
    setViewModalOpen(true);
  };

  return (
    <div>
      <PageHeader title="Calendar" routeName="calendar">
        <CalendarSubscriptionCard subscriptionUrl={subscriptionUrl} />
      </PageHeader>

      <CourseCalendar
        events={events}
        onEventClick={handleEventClick}
        onEventDrop={null}
        onMonthChange={handleMonthChange}
        showCreator={true}
      />

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
            <EventCard
              event={selectedEvent}
              showCreator={true}
              compact={false}
            />
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
