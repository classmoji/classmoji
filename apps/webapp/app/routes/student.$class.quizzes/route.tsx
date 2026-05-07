import { Outlet, useNavigate, useLocation } from 'react-router';
import { useState } from 'react';
import {
  Table,
  Badge,
  Typography,
  Button,
  Modal,
  Tag,
  Tooltip,
  Space,
  Select,
  Spin,
} from 'antd';
import { CheckCircleOutlined, PlayCircleOutlined, TrophyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Route } from './+types/route';
import { Countdown } from '~/components';
import { assertClassroomAccess } from '~/utils/helpers';
import { formatDuration } from '~/utils/quizUtils';

const { Text } = Typography;

interface FocusMetrics {
  percentage: number;
  focusedMs: number;
  totalMs: number;
}

interface QuizAttempt {
  id: string;
  attemptNumber: number;
  status: string;
  partialCreditScore: number | null;
  completed_at: string | Date | null;
  isCounting: boolean;
  focusMetrics: FocusMetrics | null;
  [key: string]: unknown;
}

interface AttemptsSummary {
  count: number;
  maxAttempts: number;
  currentScore: number | null;
  canCreateNew: boolean;
  [key: string]: unknown;
}

interface StudentQuiz {
  id: string;
  name: string;
  assignmentTitle: string;
  module_id: string | null;
  include_code_context: boolean;
  dueDate: string | Date | null;
  status: string;
  weight: number;
  questionCount: number;
  maxAttempts: number;
  gradingStrategy: string;
  attemptCount: number;
  attempts: QuizAttempt[];
  attemptsSummary: AttemptsSummary;
  attemptStatus: string | null;
  score: number | null;
}

interface GitHubRepo {
  name: string;
}

const getGradingStrategyLabel = (strategy: string) => {
  switch (strategy) {
    case 'HIGHEST':
      return 'Best Score';
    case 'MOST_RECENT':
      return 'Latest';
    case 'FIRST':
      return 'First';
    default:
      return 'Best Score';
  }
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const { ClassmojiService } = await import('@classmoji/services');
  const classSlug = params.class!;
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'ASSISTANT', 'OWNER'],
    resourceType: 'STUDENT_QUIZ_ACCESS',
    attemptedAction: 'view_student_quizzes',
  });

  // Get classroom settings
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  // Check if quizzes are enabled for this classroom
  if (settings?.quizzes_enabled === false) {
    throw new Response('Quizzes are currently disabled for this classroom', { status: 403 });
  }

  const [quizzes, user] = await Promise.all([
    ClassmojiService.quiz.getQuizzesForStudent(classroom.id, userId, membership),
    ClassmojiService.user.findById(userId),
  ]);

  // Transform quizzes for frontend compatibility
  const transformedQuizzes = quizzes.map(quiz => {
    return {
      id: quiz.id?.toString() || quiz.id,
      name: quiz.name,
      assignmentTitle: quiz.module?.title || 'Unlinked',
      module_id: quiz.module_id,
      include_code_context: quiz.include_code_context,
      dueDate: quiz.due_date,
      status: quiz.status,
      weight: quiz.weight,
      questionCount: quiz.question_count || 5,
      maxAttempts: quiz.max_attempts ?? 1,
      gradingStrategy: quiz.grading_strategy || 'HIGHEST',

      // Attempt metadata from new service
      attemptCount: quiz.attemptCount || 0,
      attempts: quiz.attempts || [],
      attemptsSummary: quiz.attemptsSummary || {},

      // Backward compatibility
      attemptStatus:
        quiz.attemptsSummary?.count > 0 ? quiz.attempts[0]?.status || 'in_progress' : null,
      score: quiz.attemptsSummary?.currentScore || null,
    };
  });

  return {
    org: params.class,
    classroomId: classroom.id?.toString() || classroom.id,
    userId: userId?.toString() || userId,
    userLogin: user?.login || null,
    userRole: membership?.role || null,
    quizzes: transformedQuizzes,
  };
}

export default function StudentQuizzes({ loaderData }: Route.ComponentProps) {
  const { quizzes: rawQuizzes, org, userRole } = loaderData;
  const quizzes = rawQuizzes as unknown as StudentQuiz[];
  const [activeTab, setActiveTab] = useState('current');
  const navigate = useNavigate();
  const location = useLocation();

  // Repo selection state for TAs/admins on code-aware quizzes
  const [repoModalVisible, setRepoModalVisible] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [pendingQuiz, setPendingQuiz] = useState<StudentQuiz | null>(null);

  // Derive role prefix from current URL (e.g., /student or /assistant)
  const rolePrefix = location.pathname.split('/')[1];

  // Fetch available repos from GitHub org
  const fetchRepos = async () => {
    setLoadingRepos(true);
    try {
      const response = await fetch(`/api/github-repos?classroomSlug=${org}`);
      if (!response.ok) {
        throw new Error('Failed to fetch repos');
      }
      const data = await response.json();
      setRepos(data);
    } catch (error: unknown) {
      console.error('[Quiz] Error fetching repos:', error);
      Modal.error({
        title: 'Error',
        content: 'Failed to fetch repositories. Please try again.',
      });
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleNewAttempt = async (quiz: StudentQuiz) => {
    // Check if this is a code-aware quiz and user is TA/admin
    const isInstructor = userRole ? ['OWNER', 'ASSISTANT'].includes(userRole) : false;
    if (quiz.include_code_context && isInstructor) {
      // Show repo selection modal first
      setPendingQuiz(quiz);
      setRepoModalVisible(true);
      fetchRepos();
      return; // Don't proceed until repo is selected
    }

    // Original flow for students or non-code-aware quizzes
    await createNewAttempt(quiz, null);
  };

  const createNewAttempt = async (quiz: StudentQuiz | null, repoName: string | null) => {
    // Confirm if max attempts reached
    const { canCreateNew, maxAttempts } = quiz!.attemptsSummary;

    if (!canCreateNew) {
      Modal.error({
        title: 'Maximum Attempts Reached',
        content: `You have reached the maximum number of attempts (${maxAttempts}) for this quiz.`,
      });
      return;
    }

    // Create new attempt via API
    try {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _action: 'restartQuiz',
          quizId: quiz!.id,
          repoName, // Pass repo name for instructors
        }),
      });

      const result = await response.json();

      if (!result.success) {
        // If there's an incomplete attempt, offer to resume it
        if (result.reason === 'incomplete_attempt_exists' && result.existingAttemptId) {
          Modal.confirm({
            title: 'Resume or Start New?',
            content: 'You have an in-progress attempt. Would you like to resume it?',
            okText: 'Resume',
            cancelText: 'Cancel',
            onOk: () => {
              navigate(
                `/${rolePrefix}/${org}/quizzes/${quiz!.id}/attempt/${result.existingAttemptId}`
              );
            },
          });
          return;
        }
        Modal.error({
          title: 'Cannot Start Quiz',
          content: result.message,
        });
        return;
      }

      // Start the quiz
      await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _action: 'startQuiz',
          quizId: quiz!.id,
          attemptId: result.attemptId,
        }),
      });

      // Navigate to the new attempt
      navigate(`/${rolePrefix}/${org}/quizzes/${quiz!.id}/attempt/${result.attemptId}`);
    } catch (error: unknown) {
      console.error('Error creating new attempt:', error);
      Modal.error({
        title: 'Error',
        content: 'Failed to create new attempt. Please try again.',
      });
    }
  };

  const handleRepoSelected = () => {
    if (!selectedRepo) {
      Modal.warning({
        title: 'No Repository Selected',
        content: 'Please select a repository to continue.',
      });
      return;
    }

    // Close modal
    setRepoModalVisible(false);

    // Create attempt with selected repo
    createNewAttempt(pendingQuiz, selectedRepo);

    // Reset state
    setSelectedRepo(null);
    setPendingQuiz(null);
  };

  const handleAttemptClick = (quiz: StudentQuiz, attempt: QuizAttempt) => {
    navigate(`/${rolePrefix}/${org}/quizzes/${quiz.id}/attempt/${attempt.id}`);
  };

  // Filter functions for different tabs
  const filterQuizzes = (quizzes: StudentQuiz[], tab: string) => {
    const publishedQuizzes = quizzes.filter(q => q.status === 'PUBLISHED');

    switch (tab) {
      case 'current':
        // Current = not yet completed (available, in-progress, or overdue)
        return publishedQuizzes.filter(q => !q.attempts.some(a => a.status === 'completed'));
      case 'completed':
        return publishedQuizzes.filter(q => q.attempts.some(a => a.status === 'completed'));
      case 'all':
      default:
        return publishedQuizzes;
    }
  };

  // Nested table for attempts
  const renderAttempts = (quiz: StudentQuiz) => {
    const attemptColumns = [
      {
        title: '#',
        dataIndex: 'attemptNumber',
        key: 'attemptNumber',
        width: '8%',
        render: (num: number, record: QuizAttempt) => (
          <Space>
            {num}
            {record.isCounting && (
              <Tooltip
                title={`Counting toward grade (${getGradingStrategyLabel(quiz.gradingStrategy)})`}
              >
                <TrophyOutlined style={{ color: '#fadb14' }} />
              </Tooltip>
            )}
          </Space>
        ),
      },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        width: '15%',
        render: (status: string) => {
          if (status === 'completed') {
            return <Badge status="success" text="Completed" />;
          }
          return <Badge status="processing" text="In Progress" />;
        },
      },
      {
        title: 'Score',
        dataIndex: 'partialCreditScore',
        key: 'score',
        width: '12%',
        render: (score: number | null) => {
          const displayScore = score ?? null;
          if (displayScore === null) return <Text type="secondary">-</Text>;
          const color =
            displayScore >= 90
              ? 'green'
              : displayScore >= 70
                ? 'blue'
                : displayScore >= 50
                  ? 'orange'
                  : 'red';
          return <Tag color={color}>{displayScore}%</Tag>;
        },
      },
      {
        title: 'Time Spent',
        key: 'timeSpent',
        width: '15%',
        render: (_: unknown, record: QuizAttempt) => {
          if (!record.focusMetrics) return <Text type="secondary">-</Text>;

          const { percentage, focusedMs, totalMs } = record.focusMetrics;
          const clampedPercentage = Math.max(0, Math.min(100, percentage));
          const color =
            clampedPercentage > 98 ? 'green' : clampedPercentage >= 90 ? 'orange' : 'red';
          const timeStr = formatDuration(totalMs, { compact: true });

          return (
            <Tooltip
              title={`Focused: ${formatDuration(focusedMs, { compact: true })} / Total: ${timeStr}`}
              placement="top"
            >
              <Space size="small">
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  {timeStr}
                  can{' '}
                </Text>
                <Tag color={color} style={{ fontSize: '11px', margin: 0 }}>
                  {clampedPercentage}%
                </Tag>
              </Space>
            </Tooltip>
          );
        },
      },
      {
        title: 'Completed',
        dataIndex: 'completed_at',
        key: 'completed',
        width: '20%',
        render: (completedAt: string | null) => {
          if (!completedAt) return <Text type="secondary">In Progress</Text>;
          // Handle different date formats
          const date = dayjs(completedAt);
          if (!date.isValid()) {
            console.error('[QuizAttempts] Invalid date:', completedAt);
            return <Text type="secondary">-</Text>;
          }
          return date.format('MMM D, YYYY h:mm A');
        },
      },
      {
        title: 'Actions',
        key: 'actions',
        width: '12%',
        render: (_: unknown, record: QuizAttempt) => {
          const buttonText = record.status === 'completed' ? 'Review' : 'Resume';
          const buttonIcon =
            record.status === 'completed' ? <CheckCircleOutlined /> : <PlayCircleOutlined />;

          return (
            <Button
              type="link"
              size="small"
              icon={buttonIcon}
              onClick={() => handleAttemptClick(quiz, record)}
            >
              {buttonText}
            </Button>
          );
        },
      },
    ];

    return (
      <Table
        columns={attemptColumns}
        dataSource={quiz.attempts}
        rowKey="id"
        pagination={false}
        size="small"
      />
    );
  };

  const columns = [
    {
      title: 'Quiz Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: StudentQuiz) => (
        <Space>
          <span className="font-medium text-gray-800 dark:text-gray-200">{name}</span>
          {record.weight === 0 && (
            <Tooltip title="This quiz won't affect your grade">
              <Tag color="gold" style={{ fontSize: '11px', margin: 0 }}>
                Practice
              </Tag>
            </Tooltip>
          )}
          {record.attemptCount > 0 && (
            <Badge count={record.attemptCount} style={{ backgroundColor: '#52c41a' }} />
          )}
        </Space>
      ),
    },
    {
      title: 'Module',
      dataIndex: 'assignmentTitle',
      key: 'module',
      render: (title: string) => <Text type="secondary">{title}</Text>,
    },
    {
      title: 'Current Score',
      key: 'currentScore',
      width: '15%',
      render: (_: unknown, record: StudentQuiz) => {
        const { currentScore } = record.attemptsSummary;
        if (currentScore === null) return <Text type="secondary">-</Text>;

        const color =
          currentScore >= 90
            ? 'green'
            : currentScore >= 70
              ? 'blue'
              : currentScore >= 50
                ? 'orange'
                : 'red';

        const strategyLabel = getGradingStrategyLabel(record.gradingStrategy);

        return (
          <Tooltip title={`Graded by: ${strategyLabel}`}>
            <Tag color={color}>
              {currentScore}% <small>({strategyLabel})</small>
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Due Date',
      dataIndex: 'dueDate',
      key: 'dueDate',
      render: (dueDate: string | null) => (
        <div>
          <Countdown deadline={dueDate} />
        </div>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '15%',
      render: (_: unknown, record: StudentQuiz) => {
        const isPublished = record.status === 'PUBLISHED';
        const { canCreateNew, count, maxAttempts } = record.attemptsSummary;
        const hasUnlimited = record.maxAttempts === 0;

        const tooltipTitle = hasUnlimited
          ? 'Start a new attempt (unlimited)'
          : canCreateNew
            ? `Start attempt ${count + 1} of ${maxAttempts}`
            : `Maximum attempts reached (${maxAttempts})`;

        return (
          <Tooltip title={tooltipTitle}>
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={!isPublished || !canCreateNew}
              onClick={() => handleNewAttempt(record)}
            >
              New Attempt
            </Button>
          </Tooltip>
        );
      },
    },
  ];

  // Calculate counts for tabs
  const publishedQuizzes = quizzes.filter(q => q.status === 'PUBLISHED');
  const currentCount = filterQuizzes(quizzes, 'current').length;
  const completedCount = filterQuizzes(quizzes, 'completed').length;

  const tabs = [
    { key: 'current', label: 'Current', count: currentCount },
    { key: 'completed', label: 'Completed', count: completedCount },
    { key: 'all', label: 'All', count: publishedQuizzes.length },
  ];

  const dataSource =
    activeTab === 'all' ? publishedQuizzes : filterQuizzes(quizzes, activeTab as 'current' | 'completed');

  const emptyText =
    activeTab === 'current' ? (
      <div className="text-center py-12 text-gray-500">
        <div className="font-medium">All caught up!</div>
        <div className="text-sm">No quizzes to complete right now</div>
      </div>
    ) : activeTab === 'completed' ? (
      <div className="text-center py-12 text-gray-500">
        <div className="font-medium">No completed quizzes yet</div>
        <div className="text-sm">Completed quizzes will appear here with your scores</div>
      </div>
    ) : (
      <div className="text-center py-12 text-gray-500">
        <div className="font-medium">No quizzes published yet</div>
      </div>
    );

  return (
    <div className="min-h-full relative">
      <Outlet />

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Quizzes</h1>
      </div>

      <div className="flex -mb-px relative">
        {tabs.map((tab, idx) => {
          const isActive = tab.key === activeTab;
          const baseZ = tabs.length - idx;
          const zStyle = { zIndex: isActive ? 10 : baseZ };
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              style={
                isActive
                  ? { ...zStyle, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
                  : zStyle
              }
              className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
                idx > 0 ? '-ml-2' : ''
              } ${
                isActive
                  ? 'bg-panel border-stone-200 dark:border-neutral-800 border-b-transparent'
                  : 'bg-stone-100 dark:bg-neutral-800 text-gray-500 dark:text-gray-400 border-stone-200 dark:border-neutral-700 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
              <span
                className={`ml-2 text-[11px] tabular-nums ${
                  isActive ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      <section className="rounded-2xl rounded-tl-none bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 min-h-[calc(100vh-14rem)] p-5 sm:p-6">
        <Table
          columns={columns}
          dataSource={dataSource}
          rowKey="id"
          rowHoverable={false}
          size="small"
          pagination={{ pageSize: activeTab === 'all' ? 50 : 25 }}
          expandable={{
            expandedRowRender: renderAttempts,
            rowExpandable: record => record.attemptCount > 0,
          }}
          locale={{ emptyText }}
        />
      </section>

      {/* Repository selection modal for TAs/admins on code-aware quizzes */}
      <Modal
        title="Select Test Repository"
        open={repoModalVisible}
        onOk={handleRepoSelected}
        onCancel={() => {
          setRepoModalVisible(false);
          setSelectedRepo(null);
          setPendingQuiz(null);
        }}
        okText="Start Quiz"
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
            options={repos.map(r => ({ value: r.name, label: r.name }))}
          />
        )}
      </Modal>
    </div>
  );
}
