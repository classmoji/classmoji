import { useLoaderData, Outlet, useNavigate, useLocation } from 'react-router';
import { useState } from 'react';
import { Table, Badge, Typography, Button, Modal, Tag, Tabs, Tooltip, Space, Select, Spin } from 'antd';
import { CheckCircleOutlined, PlayCircleOutlined, TrophyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { PageHeader, Countdown } from '~/components';
import { assertClassroomAccess } from '~/utils/helpers';
import { formatDuration } from '~/utils/quizUtils';

const { Text } = Typography;

const getGradingStrategyLabel = strategy => {
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

export async function loader({ params, request }) {
  const { ClassmojiService } = await import('@classmoji/services');
  const { class: classSlug } = params;
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

export default function StudentQuizzes() {
  const { quizzes, org, userRole } = useLoaderData();
  const [activeTab, setActiveTab] = useState('current');
  const navigate = useNavigate();
  const location = useLocation();

  // Repo selection state for TAs/admins on code-aware quizzes
  const [repoModalVisible, setRepoModalVisible] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [pendingQuiz, setPendingQuiz] = useState(null);

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
    } catch (error) {
      console.error('[Quiz] Error fetching repos:', error);
      Modal.error({
        title: 'Error',
        content: 'Failed to fetch repositories. Please try again.',
      });
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleNewAttempt = async quiz => {
    // Check if this is a code-aware quiz and user is TA/admin
    const isInstructor = ['OWNER', 'ASSISTANT'].includes(userRole);
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

  const createNewAttempt = async (quiz, repoName) => {
    // Confirm if max attempts reached
    const { canCreateNew, maxAttempts } = quiz.attemptsSummary;

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
          quizId: quiz.id,
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
                `/${rolePrefix}/${org}/quizzes/${quiz.id}/attempt/${result.existingAttemptId}`
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
          quizId: quiz.id,
          attemptId: result.attemptId,
        }),
      });

      // Navigate to the new attempt
      navigate(`/${rolePrefix}/${org}/quizzes/${quiz.id}/attempt/${result.attemptId}`);
    } catch (error) {
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

  const handleAttemptClick = (quiz, attempt) => {
    navigate(`/${rolePrefix}/${org}/quizzes/${quiz.id}/attempt/${attempt.id}`);
  };

  // Filter functions for different tabs
  const filterQuizzes = (quizzes, tab) => {
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
  const renderAttempts = quiz => {
    const attemptColumns = [
      {
        title: '#',
        dataIndex: 'attemptNumber',
        key: 'attemptNumber',
        width: '8%',
        render: (num, record) => (
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
        render: status => {
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
        render: score => {
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
        render: (_, record) => {
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
        render: completedAt => {
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
        render: (_, record) => {
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
      render: (name, record) => (
        <Space>
          <span style={{ fontSize: '16px' }}>🧑‍💻</span>
          <span className="font-medium">{name}</span>
          {record.weight === 0 && (
            <Tooltip title="This quiz won't affect your grade">
              <Tag color="gold" style={{ fontSize: '11px', margin: 0 }}>Practice</Tag>
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
      render: title => <Text type="secondary">{title}</Text>,
    },
    {
      title: 'Current Score',
      key: 'currentScore',
      width: '15%',
      render: (_, record) => {
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
      render: dueDate => (
        <div>
          <Countdown deadline={dueDate} />
        </div>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '15%',
      render: (_, record) => {
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

  const tabItems = [
    {
      key: 'current',
      label: `📝 Current (${currentCount})`,
      children: (
        <Table
          columns={columns}
          dataSource={filterQuizzes(quizzes, 'current')}
          rowKey="id"
          rowHoverable={false}
          size="small"
          pagination={{ pageSize: 25 }}
          expandable={{
            expandedRowRender: renderAttempts,
            rowExpandable: record => record.attemptCount > 0,
          }}
          locale={{
            emptyText: (
              <div className="text-center py-12 text-gray-500">
                <div className="text-6xl mb-4">✨</div>
                <h3 className="text-xl font-semibold text-gray-700 mb-2">All caught up!</h3>
                <p>No quizzes to complete right now</p>
              </div>
            ),
          }}
        />
      ),
    },
    {
      key: 'completed',
      label: `✅ Completed (${completedCount})`,
      children: (
        <Table
          columns={columns}
          dataSource={filterQuizzes(quizzes, 'completed')}
          rowKey="id"
          rowHoverable={false}
          size="small"
          pagination={{ pageSize: 25 }}
          expandable={{
            expandedRowRender: renderAttempts,
            rowExpandable: record => record.attemptCount > 0,
          }}
          locale={{
            emptyText: (
              <div className="text-center py-12 text-gray-500">
                <div className="text-6xl mb-4">📝</div>
                <h3 className="text-xl font-semibold text-gray-700 mb-2">No completed quizzes yet</h3>
                <p>Completed quizzes will appear here with your scores</p>
              </div>
            ),
          }}
        />
      ),
    },
    {
      key: 'all',
      label: `📋 All (${publishedQuizzes.length})`,
      children: (
        <Table
          columns={columns}
          dataSource={publishedQuizzes}
          rowKey="id"
          rowHoverable={false}
          size="small"
          pagination={{ pageSize: 50 }}
          expandable={{
            expandedRowRender: renderAttempts,
            rowExpandable: record => record.attemptCount > 0,
          }}
        />
      ),
    },
  ];

  return (
    <div className="relative">
      {/* Outlet renders child routes (attempt drawer) */}
      <Outlet />

      <PageHeader title="Interactive Quizzes" routeName="quizzes" />

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} size="large" />

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
              option.label.toLowerCase().includes(input.toLowerCase())
            }
            options={repos.map(r => ({ value: r.name, label: r.name }))}
          />
        )}
      </Modal>
    </div>
  );
}
