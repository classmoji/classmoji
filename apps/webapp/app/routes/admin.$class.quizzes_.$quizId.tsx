import { useLocation, useNavigate, useParams, Outlet, useFetcher } from 'react-router';
import { useEffect, useState } from 'react';
import type { Route } from './+types/admin.$class.quizzes_.$quizId';
import { Table, Button, Tag, Tooltip, Badge, Space, Modal, Select, Spin } from 'antd';
import { useCallout } from '@classmoji/ui-components';
import { IconEye, IconArrowLeft, IconClock, IconTrophy, IconChartBar } from '@tabler/icons-react';
import { TrophyOutlined, PlayCircleOutlined, ClearOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { UserThumbnailView, GradeBadge, SectionHeader } from '~/components';
import { useGitWeb } from '~/hooks/useGitWeb';
import { formatDuration } from '~/utils/quizUtils';
import {
  buildQuizResultRows,
  quizResultsQuizView,
  type QuizFocusMetrics as FocusMetrics,
  type QuizResultAttempt as QuizAttempt,
  type QuizResultStudent as QuizStudent,
} from '~/utils/quizPayloads';
import { namedAction } from 'remix-utils/named-action';
import { assertClassroomMutationAllowed } from '~/utils/routeAuth.server';

dayjs.extend(relativeTime);

interface StatCardProps {
  value: string | number;
  label: string;
  icon?: React.ComponentType<{ size: number; className: string }>;
  color?: string;
}

/**
 * An attempt's late hours: a pill when late, "On time" when not, a dash where
 * lateness does not apply (a staff preview, a quiz with no due date). With the
 * score the attempt counts for after the late penalty, when it differs.
 */
const LateCell = ({ hours, counted = null }: { hours: number | null; counted?: number | null }) => {
  if (hours === null) return <span className="text-gray-400 dark:text-gray-500">—</span>;
  if (hours === 0) return <span className="text-xs text-gray-500 dark:text-gray-400">On time</span>;
  const pill = (
    <span className="inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-300 whitespace-nowrap">
      {hours}h late
    </span>
  );
  return counted !== null ? (
    <Tooltip title={`Counts as ${Math.round(counted * 10) / 10}% after the late penalty`}>
      {pill}
    </Tooltip>
  ) : (
    pill
  );
};

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { ClassmojiService } = await import('@classmoji/services');
  const { addAuditLog, assertClassroomAccess } = await import('~/utils/helpers');
  const { quizzesVisibleOrThrow } = await import('~/utils/classroomProFlag.server');

  const classSlug = params.class!;
  const quizId = params.quizId!;

  // Authenticate and authorize
  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'QUIZ_DETAILS',
    attemptedAction: 'view',
  });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  const quiz = await ClassmojiService.quiz.findById(quizId);

  if (!quiz || quiz.classroom_id !== classroom.id) {
    throw new Response('Quiz not found', { status: 404 });
  }

  // Lateness is measured from the quiz's due date plus the hours each student
  // bought, for students on the roster only: anyone else's attempts are
  // previews and are never late. A quiz with no due date is never late.
  const assignment = quiz.assignment;
  const penalty: unknown = classroom.settings?.late_penalty_points_per_hour;
  const latePenaltyPerHour = typeof penalty === 'number' ? penalty : 0;
  const [attempts, late] = await Promise.all([
    ClassmojiService.quizAttempt.findByQuiz(quiz.id),
    assignment?.student_deadline
      ? Promise.all([
          ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT'),
          ClassmojiService.token.netQuizExtensionHoursByStudent({
            classroomId: classroom.id,
            assignmentId: assignment.id,
          }),
        ]).then(([roster, extensionHours]) => ({
          studentDeadline: assignment.student_deadline,
          latePenaltyPerHour,
          extensionHours,
          studentIds: new Set(roster.map(student => student.id)),
        }))
      : null,
  ]);

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'QUIZ_DETAILS',
    resourceId: quiz.id.toString(),
  });

  // Rows carry the fields this page renders and nothing else — see
  // ~/utils/quizPayloads. `findByQuiz` already joins each attempt's user, and
  // `quiz` (from findById) joins every attempt again, so neither is sent as-is.
  const { students, viewerAttempt } = buildQuizResultRows({
    attempts,
    gradingStrategy: quiz.grading_strategy,
    viewerId: userId,
    late,
  });

  return {
    quiz: quizResultsQuizView(quiz),
    students,
    // The viewer's own latest attempt, for resuming or restarting a preview.
    adminAttempt: viewerAttempt,
  };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { ClassmojiService } = await import('@classmoji/services');
  const { addClassroomAuditLog, assertClassroomAccess } = await import('~/utils/helpers');
  const { quizzesVisibleOrThrow } = await import('~/utils/classroomProFlag.server');
  const classSlug = params.class!;
  const quizId = params.quizId!;

  // Authenticate FIRST, before the visibility check and before the body is read.
  //
  // This gate used to live inside the one named branch below, which made the
  // action's coverage a property of how many branches happened to exist rather
  // than of the action: a second branch added later would have been ungated by
  // default, and an unauthenticated caller could reach the visibility lookup and
  // request.json() on the way in. Hoisting it makes the guarantee structural.
  // The list is unchanged — the teaching team may clear their own preview
  // attempts — and this route is now served under /assistant and /teacher as
  // well as /admin, so it answers for three prefixes.
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'QUIZ_PREVIEW_ATTEMPTS',
    attemptedAction: 'clear_own_attempts',
    metadata: {
      quiz_id: quizId,
    },
  });
  // Every branch of this action mutates, so the classroom-status check belongs
  // with the gate rather than inside a branch.
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  const data = await request.json();
  console.log('[Quiz Detail Action] Received action:', data._action);

  // Create FormData with the action from the JSON
  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  return namedAction(formData, {
    async clearMyAttempts() {
      // Delete only this authenticated user's attempts for this specific quiz
      // The userId from assertClassroomAccess ensures we only clear the authenticated user's attempts
      await ClassmojiService.quizAttempt.clearForUserAndQuiz(userId, quizId, classroom.id);

      // This route's loader already logs a VIEW; the mutation logged nothing.
      // Scoped to one quiz, so the quiz is the affected resource — which is
      // what distinguishes it from the classroom-wide clear on the quiz list.
      await addClassroomAuditLog({
        classroomId: classroom.id,
        userId,
        role: membership!.role,
        action: 'DELETE',
        resourceType: 'QUIZ',
        resourceId: quizId,
        metadata: { tool: 'web:quiz.clear_my_attempts', scope: 'quiz' },
      });

      return new Response(
        JSON.stringify({ success: 'Your preview attempts for this quiz have been cleared' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    },
  });
};

const QuizView = ({ loaderData }: Route.ComponentProps) => {
  const callout = useCallout();
  const { quiz, students, adminAttempt } = loaderData;
  const { terms } = useGitWeb();
  const navigate = useNavigate();
  const { class: classSlug, quizId } = useParams();
  const fetcher = useFetcher();
  // Served under every prefix this route's gate allows (/admin, /teacher and /assistant),
  // so links stay on the prefix the user arrived on.
  const rolePrefix = useLocation().pathname.split('/')[1];

  // Repo selection state for code-aware quiz preview
  const [repoModalVisible, setRepoModalVisible] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repos, setRepos] = useState<Record<string, unknown>[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [_pendingPreviewAction, setPendingPreviewAction] = useState<string | null>(null); // 'new' or 'resume'

  // Show success message when clearing attempts
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      callout.show({ variant: 'success', title: fetcher.data.success });
    }
  }, [fetcher.state, fetcher.data]);

  // Fetch available repos from GitHub org
  const fetchRepos = async () => {
    setLoadingRepos(true);
    try {
      const response = await fetch(`/api/github-repos?classroomSlug=${classSlug}`);
      if (!response.ok) {
        throw new Error('Failed to fetch repos');
      }
      const data = await response.json();
      setRepos(data);

      // Restore last used repo from localStorage
      const lastUsed = localStorage.getItem(`lastTestRepo_${quizId}`);
      if (lastUsed && data.some((r: Record<string, unknown>) => (r.ref ?? r.name) === lastUsed)) {
        setSelectedRepo(lastUsed);
      }
    } catch (error: unknown) {
      console.error('[Preview] Error fetching repos:', error);
      callout.show({ variant: 'error', title: `Could not load ${terms.repos}` });
    } finally {
      setLoadingRepos(false);
    }
  };

  const createNewPreviewAttempt = async (repoName: string | null = null) => {
    try {
      // Create new attempt with repoName saved to agent_config
      // QuizAttemptInterface will auto-start and read repoName from agent_config
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _action: 'restartQuiz',
          quizId: quiz.id,
          attemptId: adminAttempt?.id || null, // For cleanup
          repoName, // Saved to agent_config for QuizAttemptInterface to use
        }),
      });

      // A body that isn't JSON (an error page) reads as no body at all. The
      // server's `message` is fixed copy; anything else gets this page's own.
      const result = await response.json().catch(() => null);

      if (!result?.success) {
        Modal.error({
          title: 'Cannot Start Preview',
          content:
            typeof result?.message === 'string' && result.message
              ? result.message
              : 'Failed to create preview attempt. Please try again.',
        });
        return;
      }

      // Navigate to preview route - QuizAttemptInterface will call startQuiz
      navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}/preview/${result.attemptId}`);
    } catch (error: unknown) {
      console.error('[Preview] Error creating attempt:', error);
      Modal.error({
        title: 'Error',
        content: 'Failed to create preview attempt. Please try again.',
      });
    }
  };

  // Resume existing attempt - just navigate, quiz continues with existing context
  // QuizAttemptInterface won't auto-start because messages already exist
  const resumePreviewAttempt = () => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}/preview/${adminAttempt!.id}`);
  };

  const handlePreviewQuiz = () => {
    console.log('[Admin Preview] Opening preview for quiz:', quiz);

    // For code-aware quizzes, show repo selection modal for new attempts only
    if (quiz.include_code_context) {
      // Check for existing in-progress attempt to determine action
      if (adminAttempt && !adminAttempt.completed_at) {
        Modal.confirm({
          title: 'Resume or Start New?',
          content:
            'You have an in-progress preview attempt. Would you like to resume or start fresh?',
          okText: 'Start New',
          cancelText: 'Resume',
          onOk: () => {
            // Show repo selection for new attempt
            setPendingPreviewAction('new');
            setRepoModalVisible(true);
            fetchRepos();
          },
          onCancel: () => {
            // Resume navigates directly - quiz continues with existing context
            // No need to select repo since it was already explored
            resumePreviewAttempt();
          },
        });
      } else {
        setPendingPreviewAction('new');
        setRepoModalVisible(true);
        fetchRepos();
      }
    } else {
      // Non-code-aware quiz - proceed without repo selection
      if (adminAttempt && !adminAttempt.completed_at) {
        Modal.confirm({
          title: 'Resume or Start New?',
          content:
            'You have an in-progress preview attempt. Would you like to resume or start fresh?',
          okText: 'Start New',
          cancelText: 'Resume',
          onOk: () => createNewPreviewAttempt(),
          onCancel: () => {
            navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}/preview/${adminAttempt.id}`);
          },
        });
      } else {
        createNewPreviewAttempt();
      }
    }
  };

  // Handle repo selection confirmation (only used for new attempts now)
  const handleRepoSelected = () => {
    if (!selectedRepo) {
      callout.show({ variant: 'info', title: `Pick a ${terms.repo} first` });
      return;
    }

    // Save selection to localStorage for next time
    localStorage.setItem(`lastTestRepo_${quizId}`, selectedRepo);

    // Close modal and create new preview with selected repo
    setRepoModalVisible(false);
    createNewPreviewAttempt(selectedRepo);

    // Reset state
    setSelectedRepo(null);
    setPendingPreviewAction(null);
  };

  const handleClearMyAttempts = () => {
    Modal.confirm({
      title: 'Clear Your Preview Attempts',
      content:
        'This will delete all your preview attempts for this quiz. This action cannot be undone.',
      okText: 'Clear',
      okType: 'danger',
      onOk: () => {
        fetcher.submit(
          { _action: 'clearMyAttempts' },
          { method: 'POST', encType: 'application/json' }
        );
      },
    });
  };

  // Calculate stats from all attempts across all students
  const allAttempts = students.flatMap((s: QuizStudent) => s.attempts);
  const completedAttempts = allAttempts.filter((a: QuizAttempt) => a.completed_at !== null);
  const inProgressAttempts = allAttempts.filter((a: QuizAttempt) => a.completed_at === null);
  const scores = completedAttempts
    .map((a: QuizAttempt) => a.partialCreditScore)
    .filter((score: number | null): score is number => score !== null && score !== undefined);

  const stats = {
    totalAttempts: allAttempts.length,
    completedAttempts: completedAttempts.length,
    inProgressAttempts: inProgressAttempts.length,
    averageScore:
      scores.length > 0
        ? (scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1)
        : 0,
    highestScore: scores.length > 0 ? Math.max(...scores).toFixed(1) : 0,
    lowestScore: scores.length > 0 ? Math.min(...scores).toFixed(1) : 0,
    completionRate:
      allAttempts.length > 0
        ? ((completedAttempts.length / allAttempts.length) * 100).toFixed(1)
        : 0,
  };

  const StatCard = ({ value, label, icon: Icon, color = 'blue' }: StatCardProps) => {
    const colorClasses: Record<string, { bg: string; text: string }> = {
      blue: { bg: 'bg-blue-50 dark:bg-blue-500/10', text: 'text-blue-600 dark:text-blue-300' },
      green: { bg: 'bg-green-50 dark:bg-green-500/10', text: 'text-green-600 dark:text-green-300' },
      yellow: {
        bg: 'bg-yellow-50 dark:bg-yellow-500/10',
        text: 'text-yellow-600 dark:text-yellow-300',
      },
      orange: {
        bg: 'bg-orange-50 dark:bg-orange-500/10',
        text: 'text-orange-600 dark:text-orange-300',
      },
      purple: {
        bg: 'bg-purple-50 dark:bg-purple-500/10',
        text: 'text-purple-600 dark:text-purple-300',
      },
      red: { bg: 'bg-red-50 dark:bg-red-500/10', text: 'text-red-600 dark:text-red-300' },
    };
    const { bg: bgColor, text: textColor } = colorClasses[color] ?? colorClasses.blue;

    return (
      <div className={`${bgColor} rounded-lg p-4 text-center`}>
        {Icon && (
          <div className="flex items-center justify-center mb-2">
            <Icon size={20} className={textColor} />
          </div>
        )}
        <div className={`text-2xl font-bold ${textColor}`}>{value}</div>
        <div className="text-sm text-gray-600 dark:text-gray-400">{label}</div>
      </div>
    );
  };

  const handleViewAttempt = (attemptId: string) => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}/attempt/${attemptId}`);
  };

  // Grading strategy labels
  const getStrategyLabel = () => {
    switch (quiz.grading_strategy) {
      case 'HIGHEST':
        return 'Highest Score';
      case 'MOST_RECENT':
        return 'Most Recent';
      case 'FIRST':
        return 'First Attempt';
      default:
        return 'Highest Score';
    }
  };

  // Nested table columns for individual attempts
  const attemptColumns = [
    {
      title: '#',
      width: 80,
      render: (_: unknown, record: QuizAttempt, index: number) => (
        <Space>
          <span>{students.flatMap((s: QuizStudent) => s.attempts).length - index}</span>
          {record.isCounting && (
            <Tooltip title="This attempt counts toward final grade">
              <TrophyOutlined style={{ color: '#faad14' }} />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Status',
      width: 120,
      render: (_: unknown, record: QuizAttempt) => {
        if (record.completed_at) {
          return <Tag color="green">Completed</Tag>;
        }
        return <Tag color="blue">In Progress</Tag>;
      },
    },
    {
      title: () => <Tooltip title="Formative score (with partial credit)">Score</Tooltip>,
      width: 100,
      dataIndex: 'partialCreditScore',
      render: (score: number | null) => {
        if (score === null || score === undefined) {
          return <span className="text-gray-400 dark:text-gray-500 italic">Pending</span>;
        }
        return <GradeBadge grade={score} />;
      },
    },
    {
      title: 'Late',
      width: 90,
      dataIndex: 'lateHours',
      render: (lateHours: number | null) => <LateCell hours={lateHours} />,
    },
    {
      title: () => (
        <Tooltip title="Summative score (first attempts only)">
          <span style={{ fontSize: 11 }}>First-Attempt</span>
        </Tooltip>
      ),
      width: 100,
      dataIndex: 'firstAttemptScore',
      render: (score: number | null, record: QuizAttempt) => {
        if (record.completed_at === null) {
          return <span className="text-gray-400 dark:text-gray-500 italic text-xs">-</span>;
        }
        if (score === null || score === undefined) {
          return <span className="text-gray-400 dark:text-gray-500 italic text-xs">N/A</span>;
        }
        return <span className="text-gray-600 dark:text-gray-300 text-xs">{score}%</span>;
      },
    },
    {
      title: 'Time Spent',
      width: 140,
      dataIndex: 'focusMetrics',
      render: (focusMetrics: FocusMetrics | null, record: QuizAttempt) => {
        if (!record.completed_at) {
          return <span className="text-gray-400 dark:text-gray-500 italic">In progress</span>;
        }
        if (!focusMetrics || !focusMetrics.totalMs) {
          return <span className="text-gray-400 dark:text-gray-500 italic">N/A</span>;
        }
        return (
          <Tooltip title={`Focused: ${focusMetrics.percentage}%`}>
            <span className="text-gray-600 dark:text-gray-300">
              {formatDuration(focusMetrics.totalMs)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Completed',
      width: 180,
      dataIndex: 'completed_at',
      render: (completed_at: string | null) => {
        if (!completed_at) {
          return <span className="text-gray-400 dark:text-gray-500 italic">Not completed</span>;
        }
        return (
          <Tooltip title={dayjs(completed_at).format('MMM D, YYYY h:mm A')}>
            <span className="text-gray-600 dark:text-gray-300">
              {dayjs(completed_at).fromNow()}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Actions',
      width: 120,
      render: (_: unknown, record: QuizAttempt) => (
        <Tooltip title="View Attempt">
          <Button
            type="default"
            size="small"
            icon={<IconEye size={18} />}
            onClick={() => handleViewAttempt(record.id)}
          >
            View
          </Button>
        </Tooltip>
      ),
    },
  ];

  // Expandable row render function
  const expandedRowRender = (student: QuizStudent) => {
    return (
      <Table
        columns={attemptColumns}
        dataSource={student.attempts}
        rowKey="id"
        pagination={false}
        size="small"
        scroll={{ x: 'max-content' }}
        style={{ marginLeft: 48 }}
      />
    );
  };

  // Main table columns (students)
  const columns = [
    {
      title: 'Student',
      width: 250,
      fixed: 'left' as const,
      render: (_: unknown, record: QuizStudent) => <UserThumbnailView user={record.user} />,
    },
    {
      title: 'Attempts',
      width: 120,
      dataIndex: 'attemptCount',
      render: (count: number) => (
        <Tooltip
          title={`${count} total attempts. Max: ${quiz.max_attempts === 0 ? 'unlimited' : quiz.max_attempts}`}
        >
          <Badge count={count} style={{ backgroundColor: '#1890ff' }} showZero />
        </Tooltip>
      ),
    },
    {
      title: () => (
        <Tooltip
          title={`Formative score (with partial credit) of the attempt that counts - ${getStrategyLabel()} strategy, after the late penalty`}
        >
          <Space>
            Current Score
            <TrophyOutlined style={{ color: '#faad14', fontSize: 14 }} />
          </Space>
        </Tooltip>
      ),
      width: 150,
      dataIndex: 'currentScore',
      render: (score: number | null) => {
        if (score === null) {
          return <span className="text-gray-400 dark:text-gray-500 italic">No score</span>;
        }
        return <GradeBadge grade={score} />;
      },
      sorter: (a: QuizStudent, b: QuizStudent) => (a.currentScore || 0) - (b.currentScore || 0),
    },
    {
      title: () => (
        <Tooltip title="Hours the counting attempt finished past the due date, after any hours the student bought">
          Late
        </Tooltip>
      ),
      width: 110,
      dataIndex: 'lateHours',
      render: (lateHours: number | null, record: QuizStudent) => (
        <LateCell
          hours={lateHours}
          counted={
            lateHours && record.countedScore !== null && record.countedScore !== record.currentScore
              ? record.countedScore
              : null
          }
        />
      ),
      sorter: (a: QuizStudent, b: QuizStudent) => (a.lateHours ?? -1) - (b.lateHours ?? -1),
    },
    {
      title: () => (
        <Tooltip title="Summative score (first attempts only) - analytics">
          <Space style={{ fontSize: 12 }}>First-Attempt</Space>
        </Tooltip>
      ),
      width: 120,
      dataIndex: 'firstAttemptScore',
      render: (score: number | null) => {
        // For now, show N/A since we don't have this data yet in the query
        // This will be populated when quiz attempts include first_attempt_percentage
        if (score === null || score === undefined) {
          return <span className="text-gray-400 dark:text-gray-500 italic text-xs">N/A</span>;
        }
        return <span className="text-gray-600 dark:text-gray-300">{score}%</span>;
      },
      sorter: (a: QuizStudent, b: QuizStudent) =>
        (a.firstAttemptScore || 0) - (b.firstAttemptScore || 0),
    },
    {
      title: 'Best Score',
      width: 120,
      dataIndex: 'bestScore',
      render: (score: number | null) => {
        if (score === null) {
          return <span className="text-gray-400 dark:text-gray-500 italic">N/A</span>;
        }
        return <GradeBadge grade={score} />;
      },
      sorter: (a: QuizStudent, b: QuizStudent) => (a.bestScore || 0) - (b.bestScore || 0),
    },
    {
      title: 'Latest Attempt',
      width: 180,
      dataIndex: 'latestAttempt',
      render: (latestAttempt: string) => (
        <Tooltip title={dayjs(latestAttempt).format('MMM D, YYYY h:mm A')}>
          <span className="text-gray-600 dark:text-gray-300">{dayjs(latestAttempt).fromNow()}</span>
        </Tooltip>
      ),
      sorter: (a: QuizStudent, b: QuizStudent) =>
        new Date(b.latestAttempt).getTime() - new Date(a.latestAttempt).getTime(),
    },
  ];

  return (
    <div className="min-h-full relative">
      {/* Outlet renders child routes (attempt view drawer) */}
      <Outlet />

      {/* Repository selection modal for code-aware quiz preview */}
      <Modal
        title={`Select Test ${terms.Repo}`}
        open={repoModalVisible}
        onOk={handleRepoSelected}
        onCancel={() => {
          setRepoModalVisible(false);
          setSelectedRepo(null);
          setPendingPreviewAction(null);
        }}
        okText="Start Preview"
        okButtonProps={{ disabled: !selectedRepo }}
      >
        <p className="mb-4 text-gray-600 dark:text-gray-300">
          Select a {terms.repo} to use for testing this code-aware quiz:
        </p>
        {loadingRepos ? (
          <div className="flex justify-center py-4">
            <Spin />
          </div>
        ) : (
          <Select
            style={{ width: '100%' }}
            placeholder={`Select a ${terms.repo}`}
            value={selectedRepo}
            onChange={setSelectedRepo}
            showSearch
            filterOption={(input, option) =>
              option!.label.toLowerCase().includes(input.toLowerCase())
            }
            options={repos.map((r: Record<string, unknown>) => ({
              value: ((r.ref as string | undefined) ?? r.name) as string,
              label: r.name as string,
            }))}
          />
        )}
      </Modal>

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            type="text"
            className="text-gray-600! hover:text-gray-900! dark:text-gray-100! dark:hover:text-white!"
            icon={<IconArrowLeft size={20} />}
            onClick={() => navigate(`/${rolePrefix}/${classSlug}/quizzes`)}
            aria-label="Back to quizzes"
          />
          <h1 className="text-lg font-semibold text-ink-1 truncate">Quiz: {quiz.name}</h1>
        </div>

        <Space>
          {adminAttempt && (
            <Tooltip title="Clear all your preview attempts for this quiz">
              <Button
                icon={<ClearOutlined />}
                onClick={handleClearMyAttempts}
                loading={
                  fetcher.state !== 'idle' && fetcher.formData?.get('_action') === 'clearMyAttempts'
                }
              >
                Clear My Attempts
              </Button>
            </Tooltip>
          )}
          <Tooltip title="Preview this quiz as a student">
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handlePreviewQuiz}>
              Preview Quiz
            </Button>
          </Tooltip>
        </Space>
      </div>

      <div className="space-y-6">
        <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
          <SectionHeader
            title="Quiz Statistics"
            subtitle="Performance overview across all attempts"
            className="mb-4"
          />

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <StatCard
              value={stats.totalAttempts}
              label="Total Attempts"
              icon={IconChartBar}
              color="blue"
            />
            <StatCard
              value={stats.completedAttempts}
              label="Completed"
              icon={IconTrophy}
              color="green"
            />
            <StatCard
              value={stats.inProgressAttempts}
              label="In Progress"
              icon={IconClock}
              color="yellow"
            />
            <StatCard value={`${stats.completionRate}%`} label="Completion Rate" color="purple" />
            <StatCard value={stats.averageScore} label="Average Score" color="blue" />
            <StatCard value={stats.highestScore} label="Highest Score" color="green" />
            <StatCard value={stats.lowestScore} label="Lowest Score" color="red" />
          </div>
        </div>

        <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
          <SectionHeader
            title="Student Attempts"
            subtitle={`${students.length} students, ${allAttempts.length} total attempts`}
            className="mb-4"
          />

          <Table
            columns={columns}
            dataSource={students}
            rowKey="userId"
            expandable={{
              expandedRowRender,
              rowExpandable: record => record.attemptCount > 0,
            }}
            pagination={{
              pageSize: 20,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} students`,
            }}
            scroll={{ x: 1200 }}
          />
        </div>
      </div>
    </div>
  );
};

export default QuizView;
