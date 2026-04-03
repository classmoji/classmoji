import { useNavigate, useParams, Outlet, useFetcher } from 'react-router';
import { useEffect, useState } from 'react';
import type { Route } from './+types/admin.$class.quizzes_.$quizId';
import {
  Card,
  Table,
  Button,
  Tag,
  Tooltip,
  Badge,
  Space,
  Modal,
  message,
  Select,
  Spin,
} from 'antd';
import { IconEye, IconArrowLeft, IconClock, IconTrophy, IconChartBar } from '@tabler/icons-react';
import { TrophyOutlined, PlayCircleOutlined, ClearOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { PageHeader, UserThumbnailView, GradeBadge, SectionHeader } from '~/components';
import { formatDuration, checkForCompletion } from '~/utils/quizUtils';
import { namedAction } from 'remix-utils/named-action';

dayjs.extend(relativeTime);

interface QuizMessage {
  role: string;
  content: string;
}

interface FocusMetrics {
  totalMs: number | null;
  focusedMs: number;
  percentage: number;
}

interface QuizAttempt {
  id: string;
  user_id: string;
  started_at: string;
  completed_at: string | null;
  total_duration_ms: number | null;
  unfocused_duration_ms: number | null;
  partial_credit_percentage: number | null;
  first_attempt_percentage: number | null;
  messages: QuizMessage[];
  messageCount: number;
  user: QuizUser;
  evaluationData: Record<string, unknown> | null;
  focusMetrics: FocusMetrics | null;
  partialCreditScore: number | null;
  firstAttemptScore: number | null;
  isCounting?: boolean;
}

interface QuizUser {
  id: string;
  name?: string;
  login?: string;
  avatar_url?: string;
}

interface QuizStudent {
  user: QuizUser;
  userId: string;
  attempts: QuizAttempt[];
  attemptCount: number;
  currentScore: number | null;
  bestScore: number | null;
  firstAttemptScore: number | null;
  countingAttemptId: string | null;
  latestAttempt: string;
}

interface StatCardProps {
  value: string | number;
  label: string;
  icon?: React.ComponentType<{ size: number; className: string }>;
  color?: string;
}

// Helper function to find evaluation data in attempt messages
const getEvaluationData = (attempt: Pick<QuizAttempt, 'messages'>) => {
  if (!attempt?.messages) return null;

  for (const msg of attempt.messages) {
    if (msg.role === 'ASSISTANT') {
      const completion = checkForCompletion(msg.content);
      if (completion) {
        return completion;
      }
    }
  }
  return null;
};

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { ClassmojiService } = await import('@classmoji/services');
  const { addAuditLog, assertClassroomAccess } = await import('~/utils/helpers');

  const classSlug = params.class!;
  const quizId = params.quizId!;

  // Authenticate and authorize
  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'QUIZ_DETAILS',
    attemptedAction: 'view',
  });

  const quiz = await ClassmojiService.quiz.findById(quizId);

  if (!quiz || quiz.classroom_id !== classroom.id) {
    throw new Response('Quiz not found', { status: 404 });
  }

  const attempts = await ClassmojiService.quizAttempt.findByQuiz(quiz.id);

  const attemptsWithUsers = await Promise.all(
    attempts.map(async attempt => {
      const user = await ClassmojiService.user.findById(attempt.user_id);
      const messages = await ClassmojiService.quizAttempt.getMessages(attempt.id);
      return {
        ...attempt,
        user,
        messageCount: messages.length,
        messages, // Include messages for each attempt
      };
    })
  );

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'QUIZ_DETAILS',
    resourceId: quiz.id.toString(),
  });

  // Find admin's attempt for preview functionality
  const adminAttempt = attemptsWithUsers.find(a => String(a.user_id) === String(userId));

  // Add evaluation and focus metrics to each attempt
  const attemptsWithEvaluation = attemptsWithUsers.map(attempt => {
    const totalDurationMs = attempt.total_duration_ms ?? null;
    const unfocusedDurationMs = attempt.unfocused_duration_ms ?? null;

    let focusMetrics = null;

    if (
      Number.isFinite(totalDurationMs) &&
      totalDurationMs! > 0 &&
      Number.isFinite(unfocusedDurationMs) &&
      unfocusedDurationMs! >= 0
    ) {
      const focusedDurationMs = Math.max(totalDurationMs! - unfocusedDurationMs!, 0);
      const ratio = focusedDurationMs / totalDurationMs!;

      focusMetrics = {
        totalMs: totalDurationMs,
        focusedMs: focusedDurationMs,
        percentage: Math.round(ratio * 100),
      };
    }

    const evaluationData = getEvaluationData(attempt);

    const partialCreditScore =
      typeof attempt.partial_credit_percentage === 'number'
        ? attempt.partial_credit_percentage
        : null;

    const firstAttemptScore =
      typeof attempt.first_attempt_percentage === 'number'
        ? attempt.first_attempt_percentage
        : null;

    return {
      ...attempt,
      evaluationData,
      focusMetrics,
      partialCreditScore,
      firstAttemptScore,
    };
  });

  // Group attempts by student
  const studentMap = new Map();

  attemptsWithEvaluation.forEach(attempt => {
    const userId = attempt.user_id.toString();

    if (!studentMap.has(userId)) {
      studentMap.set(userId, {
        user: attempt.user,
        userId,
        attempts: [],
      });
    }

    studentMap.get(userId).attempts.push(attempt);
  });

  // Transform student data with grading strategy calculations
  const students = Array.from(studentMap.values()).map(student => {
    interface AttemptWithScore {
      id: string;
      completed_at: string | null;
      started_at: string;
      partialCreditScore: number | null;
      firstAttemptScore: number | null;
      [key: string]: unknown;
    }
    const completedAttempts: AttemptWithScore[] = student.attempts.filter(
      (a: AttemptWithScore) => a.completed_at && a.partialCreditScore !== null
    );
    const attemptCount = student.attempts.length;

    // Calculate which attempt counts based on grading strategy
    let countingAttemptId = null;
    let currentScore = null;
    let bestScore = null;

    if (completedAttempts.length > 0) {
      const scores = completedAttempts.map((a: AttemptWithScore) => a.partialCreditScore ?? 0);
      bestScore = Math.max(...scores);

      switch (quiz.grading_strategy) {
        case 'HIGHEST': {
          const highest = completedAttempts.reduce((max, a) =>
            (a.partialCreditScore ?? 0) > (max.partialCreditScore ?? 0) ? a : max
          );
          countingAttemptId = highest.id;
          currentScore = highest.partialCreditScore;
          break;
        }
        case 'MOST_RECENT': {
          // Sort by completed_at to get most recent
          const sorted = [...completedAttempts].sort(
            (a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime()
          );
          countingAttemptId = sorted[0].id;
          currentScore = sorted[0].partialCreditScore;
          break;
        }
        case 'FIRST': {
          // Sort by started_at to get first
          const sorted = [...completedAttempts].sort(
            (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
          );
          countingAttemptId = sorted[0].id;
          currentScore = sorted[0].partialCreditScore;
          break;
        }
        default: {
          // Default to highest
          const highest = completedAttempts.reduce((max, a) =>
            (a.partialCreditScore ?? 0) > (max.partialCreditScore ?? 0) ? a : max
          );
          countingAttemptId = highest.id;
          currentScore = highest.partialCreditScore;
        }
      }
    }

    // Sort attempts by started_at (most recent first)
    const sortedAttempts = [...student.attempts].sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );

    // Get latest attempt timestamp
    const latestAttempt = sortedAttempts[0];

    // Calculate first-attempt score for the counting attempt
    const countingAttempt = student.attempts.find(
      (a: AttemptWithScore) => a.id === countingAttemptId
    );
    const firstAttemptScore = countingAttempt?.firstAttemptScore ?? null;

    return {
      ...student,
      attemptCount,
      currentScore,
      bestScore,
      firstAttemptScore,
      countingAttemptId,
      latestAttempt: latestAttempt.started_at,
      attempts: sortedAttempts.map(attempt => ({
        ...attempt,
        isCounting: attempt.id === countingAttemptId,
      })),
    };
  });

  return {
    quiz,
    students,
    classroom,
    adminAttempt: adminAttempt || null,
  };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { ClassmojiService } = await import('@classmoji/services');
  const { assertClassroomAccess } = await import('~/utils/helpers');
  const classSlug = params.class!;
  const quizId = params.quizId!;

  const data = await request.json();
  console.log('[Quiz Detail Action] Received action:', data._action);

  // Create FormData with the action from the JSON
  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  return namedAction(formData, {
    async clearMyAttempts() {
      // SECURITY: Only admins (OWNER/ASSISTANT) can clear preview attempts
      // The service layer scopes deletion to only the authenticated user's attempts
      const { userId, classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'ASSISTANT'],
        resourceType: 'QUIZ_PREVIEW_ATTEMPTS',
        attemptedAction: 'clear_own_attempts',
        metadata: {
          quiz_id: quizId,
        },
      });

      // Delete only this authenticated user's attempts for this specific quiz
      // The userId from assertClassroomAccess ensures we only clear the authenticated user's attempts
      await ClassmojiService.quizAttempt.clearForUserAndQuiz(userId, quizId, classroom.id);

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
  const { quiz, students, adminAttempt } = loaderData;
  const navigate = useNavigate();
  const { class: classSlug, quizId } = useParams();
  const fetcher = useFetcher();

  // Repo selection state for code-aware quiz preview
  const [repoModalVisible, setRepoModalVisible] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repos, setRepos] = useState<Record<string, unknown>[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [pendingPreviewAction, setPendingPreviewAction] = useState<string | null>(null); // 'new' or 'resume'

  // Show success message when clearing attempts
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      message.success(fetcher.data.success);
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
      if (lastUsed && data.some((r: Record<string, unknown>) => r.name === lastUsed)) {
        setSelectedRepo(lastUsed);
      }
    } catch (error: unknown) {
      console.error('[Preview] Error fetching repos:', error);
      message.error('Failed to fetch repositories');
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

      const result = await response.json();

      if (!result.success) {
        Modal.error({
          title: 'Cannot Start Preview',
          content: result.message,
        });
        return;
      }

      // Navigate to preview route - QuizAttemptInterface will call startQuiz
      navigate(`/admin/${classSlug}/quizzes/${quizId}/preview/${result.attemptId}`);
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
    navigate(`/admin/${classSlug}/quizzes/${quizId}/preview/${adminAttempt!.id}`);
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
            navigate(`/admin/${classSlug}/quizzes/${quizId}/preview/${adminAttempt.id}`);
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
      message.warning('Please select a repository');
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
    const colorClasses: Record<string, string> = {
      blue: 'bg-blue-50 text-blue-600',
      green: 'bg-green-50 text-green-600',
      yellow: 'bg-yellow-50 text-yellow-600',
      purple: 'bg-purple-50 text-purple-600',
      red: 'bg-red-50 text-red-600',
    };

    const bgColor = colorClasses[color]?.split(' ')[0] || 'bg-blue-50';
    const textColor = colorClasses[color]?.split(' ')[1] || 'text-blue-600';

    return (
      <div className={`${bgColor} rounded-lg p-4 text-center`}>
        {Icon && (
          <div className="flex items-center justify-center mb-2">
            <Icon size={20} className={textColor} />
          </div>
        )}
        <div className={`text-2xl font-bold ${textColor}`}>{value}</div>
        <div className="text-sm text-gray-600">{label}</div>
      </div>
    );
  };

  const handleViewAttempt = (attemptId: string) => {
    navigate(`/admin/${classSlug}/quizzes/${quizId}/attempt/${attemptId}`);
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
          return <span className="text-gray-400 italic">Pending</span>;
        }
        return <GradeBadge grade={score} />;
      },
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
          return <span className="text-gray-400 italic text-xs">-</span>;
        }
        if (score === null || score === undefined) {
          return <span className="text-gray-400 italic text-xs">N/A</span>;
        }
        return <span className="text-gray-600 text-xs">{score}%</span>;
      },
    },
    {
      title: 'Time Spent',
      width: 140,
      dataIndex: 'focusMetrics',
      render: (focusMetrics: FocusMetrics | null, record: QuizAttempt) => {
        if (!record.completed_at) {
          return <span className="text-gray-400 italic">In progress</span>;
        }
        if (!focusMetrics || !focusMetrics.totalMs) {
          return <span className="text-gray-400 italic">N/A</span>;
        }
        return (
          <Tooltip title={`Focused: ${focusMetrics.percentage}%`}>
            <span className="text-gray-600">{formatDuration(focusMetrics.totalMs)}</span>
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
          return <span className="text-gray-400 italic">Not completed</span>;
        }
        return (
          <Tooltip title={dayjs(completed_at).format('MMM D, YYYY h:mm A')}>
            <span className="text-gray-600">{dayjs(completed_at).fromNow()}</span>
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
          title={`Formative score (with partial credit) - Based on ${getStrategyLabel()} strategy`}
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
          return <span className="text-gray-400 italic">No score</span>;
        }
        return <GradeBadge grade={score} />;
      },
      sorter: (a: QuizStudent, b: QuizStudent) => (a.currentScore || 0) - (b.currentScore || 0),
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
          return <span className="text-gray-400 italic text-xs">N/A</span>;
        }
        return <span className="text-gray-600">{score}%</span>;
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
          return <span className="text-gray-400 italic">N/A</span>;
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
          <span className="text-gray-600">{dayjs(latestAttempt).fromNow()}</span>
        </Tooltip>
      ),
      sorter: (a: QuizStudent, b: QuizStudent) =>
        new Date(b.latestAttempt).getTime() - new Date(a.latestAttempt).getTime(),
    },
  ];

  return (
    <div className="relative">
      {/* Outlet renders child routes (attempt view drawer) */}
      <Outlet />

      {/* Repository selection modal for code-aware quiz preview */}
      <Modal
        title="Select Test Repository"
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
        <p className="mb-4 text-gray-600">
          Select a repository to use for testing this code-aware quiz:
        </p>
        {loadingRepos ? (
          <div className="flex justify-center py-4">
            <Spin />
          </div>
        ) : (
          <Select
            style={{ width: '100%' }}
            placeholder="Select a repository"
            value={selectedRepo}
            onChange={setSelectedRepo}
            showSearch
            filterOption={(input, option) =>
              option!.label.toLowerCase().includes(input.toLowerCase())
            }
            options={repos.map((r: Record<string, unknown>) => ({
              value: r.name as string,
              label: r.name as string,
            }))}
          />
        )}
      </Modal>

      <PageHeader
        routeName="quizzes"
        title={
          <div className="flex items-center gap-3">
            <Button
              type="text"
              className="text-gray-600! hover:text-gray-900! dark:text-gray-100! dark:hover:text-white!"
              icon={<IconArrowLeft size={20} />}
              onClick={() => navigate(`/admin/${classSlug}/quizzes`)}
              aria-label="Back to quizzes"
            />
            <span>Quiz: {quiz.name}</span>
          </div>
        }
      >
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
      </PageHeader>

      <div className="space-y-6">
        <Card>
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
        </Card>

        <Card>
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
        </Card>
      </div>
    </div>
  );
};

export default QuizView;
