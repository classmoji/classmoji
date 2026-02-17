import dayjs from 'dayjs';
import { IconUsersGroup, IconBrandGit, IconClock, IconProgressCheck } from '@tabler/icons-react';
import { Suspense } from 'react';
import { Await, Link, useParams } from 'react-router';
import { Alert, Skeleton, Card } from 'antd';

import {
  PageHeader,
  StatsCard,
  StatsGradingProgress,
  TAGradingLeaderboard,
  CardHeader,
} from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import SubmissionChart from './SubmissionChart';
import Leaderboard from './Leaderboard';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'DASHBOARD',
    action: 'view_dashboard',
  });

  if (!classroom) {
    throw new Response('Classroom not found', { status: 404 });
  }

  // Use git_organization.login for GitHub API calls
  const gitOrgLogin = classroom.git_organization?.login;
  let githubOrganization = null;
  if (gitOrgLogin && classroom.git_organization?.github_installation_id) {
    const gitProvider = getGitProvider(classroom.git_organization);
    githubOrganization = await gitProvider.getOrganization(gitOrgLogin);
  }

  const promises = {
    students: ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT'),
    leaderbord: ClassmojiService.helper.calculateClassLeaderboard(classSlug),
    gradingProgress: ClassmojiService.repositoryAssignment.getGradingProgress(classSlug),
    completedAssignmentsProgress:
      ClassmojiService.repositoryAssignment.getCompletionProgress(classSlug),
    lateSubmissionsPercent: ClassmojiService.repositoryAssignment.getLatePercentage(classSlug),
    recentRepositoryAssignments: ClassmojiService.repositoryAssignment.findRecentlyClosed(
      classSlug,
      dayjs().subtract(7, 'day').toDate(),
      dayjs().toDate()
    ),
    modules: ClassmojiService.module.findByClassroomSlug(classSlug),
    gradingProgressPerAssignment: ClassmojiService.helper.findClassroomGradingProgressPerAssignment(
      classroom.id
    ),
    assistantsProgress: ClassmojiService.repositoryAssignmentGrader.findGradersProgress(
      classroom.id
    ),
    githubOrganization,
  };

  return {
    data: Promise.all(Object.values(promises)),
    githubOrganization,
  };
};

const AdminDashboard = ({ loaderData }) => {
  const { data, githubOrganization } = loaderData;
  const { class: classSlug } = useParams();

  return (
    <div id="dashboard-page">
      <PageHeader title="Dashboard" routeName="dashboard" />

      {githubOrganization?.default_repository_permission !== 'none' && (
        <Alert
          message={
            <div>
              <p>
                Your current settings allow students to see other students repositories. This is not
                recommended for privacy reasons. Go to{' '}
                <Link to={`/admin/${classSlug}/settings/repos`}>Settings</Link> and select{' '}
                <span className="font-semibold">&apos;No permission&apos;</span> to disable this.
              </p>
            </div>
          }
          type="error"
          showIcon={true}
          style={{ marginBottom: '22px' }}
        />
      )}

      <Suspense fallback={<Skeleton active />}>
        <Await resolve={data}>
          {([
            students,
            leaderbord,
            gradingProgress,
            completedAssignmentsProgress,
            lateSubmissionsPercent,
            recentRepositoryAssignments,
            modules,
            gradingProgressPerAssignment,
            assistantsProgress,
          ]) => {
            const bottomStudents = leaderbord.slice(0, 5);
            const topStudents = leaderbord.slice(-5).reverse();

            return (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatsCard title="Number of Students" icon={IconUsersGroup}>
                    {students?.length || 0}
                  </StatsCard>
                  <StatsCard title="Submitted Assignments" icon={IconBrandGit}>
                    {completedAssignmentsProgress || 0}%
                  </StatsCard>
                  <StatsCard title="Late Submissions" icon={IconClock}>
                    {lateSubmissionsPercent || 0}%
                  </StatsCard>

                  <StatsCard title="Grading Progress" icon={IconProgressCheck}>
                    {gradingProgress || 0}%
                  </StatsCard>
                </div>

                <div className="mt-8">
                  <div className="flex flex-col md:flex-row md:items-stretch gap-6">
                    <div className="w-full md:w-[60%]">
                      <Card
                        className="h-full shadow-xs"
                        styles={{
                          body: {
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            padding: 20,
                          },
                        }}
                      >
                        <CardHeader>Submission History</CardHeader>
                        <div className="flex-1 min-h-[370px]">
                          <SubmissionChart
                            recentRepositoryAssignments={recentRepositoryAssignments || []}
                          />
                        </div>
                      </Card>
                    </div>
                    <div className="w-full md:w-[40%]">
                      <Leaderboard topStudents={topStudents} bottomStudents={bottomStudents} />
                    </div>
                  </div>
                  <div className="py-12">
                    <div className="flex flex-col md:flex-row gap-6">
                      <div className="w-full md:flex-1 md:min-w-0">
                        <StatsGradingProgress gradingProgress={gradingProgressPerAssignment} />
                      </div>
                      <div className="w-full md:w-[280px] md:flex-shrink-0">
                        <TAGradingLeaderboard progress={assistantsProgress} />
                      </div>
                    </div>
                  </div>
                </div>
              </>
            );
          }}
        </Await>
      </Suspense>
    </div>
  );
};

export default AdminDashboard;
