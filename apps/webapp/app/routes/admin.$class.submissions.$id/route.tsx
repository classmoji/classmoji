import { Link, useLocation } from 'react-router';
import { useState } from 'react';
import { Alert, Button } from 'antd';
import { IconChevronLeft } from '@tabler/icons-react';

import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import {
  GitHubStatsPanel,
  type GitHubStatsSnapshot,
  type EligibleStudent,
} from '~/components/features/analytics';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const repoAssignmentId = params.id!;

  const { classroom } = await requireClassroomTeachingTeam(request, classSlug, {
    resourceType: 'REPOSITORY_ASSIGNMENT',
    action: 'view_submission_analytics',
  });

  const repoAssignment = await getPrisma().repositoryAssignment.findUnique({
    where: { id: repoAssignmentId },
    include: {
      assignment: true,
      repository: {
        include: {
          student: true,
          team: true,
          module: true,
        },
      },
      analytics_snapshot: true,
    },
  });

  if (!repoAssignment || repoAssignment.repository.classroom_id !== classroom.id) {
    throw new Response('Submission not found', { status: 404 });
  }

  const studentMemberships = await ClassmojiService.classroomMembership.findStudents(
    classroom.id,
  );
  const students: EligibleStudent[] = studentMemberships.map((m) => ({
    id: m.user.id,
    name: m.user.name ?? m.user.login ?? 'Unknown',
    login: m.user.login ?? null,
  }));

  const snapshot = repoAssignment.analytics_snapshot as unknown as
    | GitHubStatsSnapshot
    | null;

  return {
    classSlug,
    repoAssignmentId,
    repoName: repoAssignment.repository.name,
    assignmentTitle: repoAssignment.assignment.title,
    deadline: repoAssignment.assignment.student_deadline?.toISOString() ?? null,
    repositoryId: repoAssignment.repository.id,
    snapshot,
    students,
  };
};

const SubmissionAnalytics = ({ loaderData }: Route.ComponentProps) => {
  const {
    classSlug,
    repoAssignmentId,
    repoName,
    assignmentTitle,
    deadline,
    repositoryId,
    snapshot,
    students,
  } = loaderData;

  const { pathname } = useLocation();
  const isAssistant = pathname.startsWith('/assistant/');
  const backHref = isAssistant
    ? `/assistant/${classSlug}/grading`
    : `/admin/${classSlug}/grades`;

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const onRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/repos/${repoAssignmentId}/refresh`, {
        method: 'POST',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Refresh failed (${res.status})`);
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="submission-analytics">
      <div className="flex items-center gap-2">
        <Link to={backHref}>
          <Button
            size="small"
            icon={<IconChevronLeft size={14} />}
            className="flex items-center"
          >
            Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {assignmentTitle}{' '}
          <span className="font-mono text-base text-gray-500 dark:text-gray-400">
            · {repoName}
          </span>
        </h1>
      </div>

      {refreshError ? (
        <Alert type="error" message={refreshError} closable />
      ) : null}

      <GitHubStatsPanel
        snapshot={snapshot}
        deadline={deadline}
        onRefresh={onRefresh}
        refreshing={refreshing}
        repositoryId={repositoryId}
        students={students}
      />
    </div>
  );
};

export default SubmissionAnalytics;
