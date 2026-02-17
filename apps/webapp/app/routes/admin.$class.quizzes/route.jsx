import { useFetcher, useNavigate, useParams, Outlet } from 'react-router';
import { Table, Button, Typography, Tag, Space, Tooltip, Popconfirm } from 'antd';
import { IconSend, IconPlus, IconBook, IconCalendar, IconTrash } from '@tabler/icons-react';
import { TableActionButtons, EditableCell, PageHeader } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { namedAction } from 'remix-utils/named-action';
import { assertClassroomAccess } from '~/utils/helpers';

const { Text } = Typography;

export async function loader({ params, request }) {
  const { class: classSlug } = params;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_ACCESS',
    attemptedAction: 'view_admin_quizzes',
  });

  // Get classroom settings
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  // Check if quizzes are enabled for this classroom
  if (settings?.quizzes_enabled === false) {
    throw new Response('Quizzes are currently disabled for this classroom', { status: 403 });
  }

  const user = await ClassmojiService.user.findById(userId);

  // Get all quizzes for admin (including drafts)
  const quizzesWithAttempts = await ClassmojiService.quiz.findByClassroom(classroom.id, membership);

  // Transform quizzes for frontend compatibility
  const transformedQuizzes = quizzesWithAttempts.map(quiz => {
    // Find admin's attempt for preview functionality
    const adminAttempt = quiz.attempts?.find(a => String(a.user_id) === String(userId));
    let attemptStatus = null;
    let score = null;

    if (adminAttempt) {
      if (adminAttempt.completed_at) {
        attemptStatus = 'completed';
        score =
          typeof adminAttempt.partial_credit_percentage === 'number'
            ? adminAttempt.partial_credit_percentage
            : null;
      } else {
        attemptStatus = 'in_progress';
      }
    }

    return {
      id: quiz.id, // Already a string UUID
      name: quiz.name,
      moduleId: quiz.module_id?.toString() || null,
      moduleTitle: quiz.module?.title || 'Unlinked',
      systemPrompt: quiz.system_prompt,
      rubricPrompt: quiz.rubric_prompt,
      subject: quiz.subject || '',
      difficultyLevel: quiz.difficulty_level || 'Beginner',
      dueDate: quiz.due_date,
      status: quiz.status,
      weight: quiz.weight,
      questionCount: quiz.question_count || 5,
      maxAttempts: quiz.max_attempts ?? 1,
      gradingStrategy: quiz.grading_strategy || 'HIGHEST',
      includeCodeContext: quiz.include_code_context || false,
      attemptsCount: quiz.attemptsCount,
      avgScore: quiz.avgScore,
      // Include admin's attempt data for preview
      attemptStatus,
      score,
      userAttempt: adminAttempt || null,
    };
  });

  return {
    org: params.class,
    classroomId: classroom.id,
    quizzes: transformedQuizzes,
    userLogin: user?.login || null,
  };
}

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  const data = await request.json();

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_ACTION',
    attemptedAction: data._action || 'unknown',
    metadata: {
      quiz_id: data.id || null,
    },
  });

  // Create FormData with the action from the JSON
  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  return namedAction(formData, {
    async createQuiz() {
      const { ...quizData } = data;
      const newQuiz = await ClassmojiService.quiz.create({
        ...quizData,
        classroomId: classroom.id,
      });
      return new Response(
        JSON.stringify({ success: 'Quiz created successfully', quizId: newQuiz.id }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    },

    async updateQuiz() {
      await ClassmojiService.quiz.update(data.id, data);
      return new Response(JSON.stringify({ success: 'Quiz updated successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async deleteQuiz() {
      await ClassmojiService.quiz.delete(data.id);
      return new Response(JSON.stringify({ success: 'Quiz deleted successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async publishQuiz() {
      await ClassmojiService.quiz.publish(data.id);
      return new Response(JSON.stringify({ success: 'Quiz published successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async updateWeight() {
      await ClassmojiService.quiz.update(data.id, {
        weight: data.weight,
      });
      return new Response(JSON.stringify({ success: 'Quiz weight updated successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async clearMyAttempts() {
      const result = await ClassmojiService.quizAttempt.clearForUser(userId, classroom.id);
      return new Response(
        JSON.stringify({
          success: `Cleared ${result.deletedCount} quiz attempt(s)`,
          deletedCount: result.deletedCount,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    },
  });
};

export default function AdminQuizzes({ loaderData }) {
  const { quizzes } = loaderData;
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();

  const handleEditQuiz = quiz => {
    navigate(`/admin/${classSlug}/quizzes/form?quizId=${quiz.id}`);
  };

  const handleDeleteQuiz = quizId => {
    fetcher.submit(
      { _action: 'deleteQuiz', id: quizId },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handleUpdateWeight = (quizId, weight) => {
    fetcher.submit(
      {
        _action: 'updateWeight',
        id: quizId,
        weight,
      },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handlePublishQuiz = quizId => {
    fetcher.submit(
      { _action: 'publishQuiz', id: quizId },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handleClearMyAttempts = () => {
    fetcher.submit({ _action: 'clearMyAttempts' }, { method: 'POST', encType: 'application/json' });
  };

  const handleViewQuiz = quiz => {
    navigate(`/admin/${classSlug}/quizzes/${quiz.id}`);
  };

  const totalWeight = quizzes
    .filter(q => q.status !== 'ARCHIVED')
    .reduce((acc, q) => acc + q.weight, 0);

  const ActionButton = ({ icon: Icon, tooltip, color = 'gray', onClick, popconfirmProps }) => {
    const button = (
      <Button
        type="text"
        icon={<Icon size={16} />}
        onClick={onClick}
        className={`hover:bg-${color}-50`}
        style={{ color: `var(--${color}-500)` }}
        size="small"
      />
    );

    if (popconfirmProps) {
      return (
        <Popconfirm {...popconfirmProps}>
          <Tooltip title={tooltip}>{button}</Tooltip>
        </Popconfirm>
      );
    }

    return <Tooltip title={tooltip}>{button}</Tooltip>;
  };

  const columns = [
    {
      title: 'Quiz Name',
      dataIndex: 'name',
      key: 'name',
      width: '25%',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: name => <span className="font-medium text-gray-800 dark:text-gray-200">{name}</span>,
    },
    {
      title: 'Module',
      dataIndex: 'moduleTitle',
      key: 'module',
      width: '20%',
      sorter: (a, b) => a.moduleTitle.localeCompare(b.moduleTitle),
      render: title => (
        <Space>
          <IconBook size={17} className="text-gray-400" />
          <Text type="secondary">{title}</Text>
        </Space>
      ),
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: '10%',
      sorter: (a, b) => a.weight - b.weight,
      render: quiz => (
        <EditableCell
          record={quiz}
          dataIndex="weight"
          onUpdate={handleUpdateWeight}
          format="number"
        />
      ),
    },
    {
      title: 'Due Date',
      dataIndex: 'dueDate',
      key: 'dueDate',
      width: '15%',
      sorter: (a, b) => {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
      },
      render: dueDate =>
        dueDate ? (
          <Space>
            <IconCalendar size={17} className="text-gray-400" />
            <Text>{new Date(dueDate).toLocaleDateString()}</Text>
          </Space>
        ) : (
          <Text type="secondary">No due date</Text>
        ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: '10%',
      sorter: (a, b) => a.status.localeCompare(b.status),
      render: status => {
        const statusConfig = {
          PUBLISHED: { color: 'green', text: 'Published' },
          DRAFT: { color: 'orange', text: 'Draft' },
          ARCHIVED: { color: 'default', text: 'Archived' },
        };
        const config = statusConfig[status] || statusConfig.DRAFT;
        return (
          <Tag color={config.color} className="font-semibold">
            {config.text}
          </Tag>
        );
      },
    },
    {
      title: 'Attempts',
      key: 'attempts',
      width: '10%',
      render: (_, record) =>
        record.status === 'PUBLISHED' ? (
          <Space direction="vertical" size={0}>
            <Text>{record.attemptsCount} attempts</Text>
            {record.avgScore !== null && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Avg: {record.avgScore}%
              </Text>
            )}
          </Space>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <TableActionButtons
          onView={() => handleViewQuiz(record)}
          onEdit={() => handleEditQuiz(record)}
          onDelete={() => handleDeleteQuiz(record.id)}
        >
          {record.status === 'DRAFT' && (
            <ActionButton
              icon={IconSend}
              tooltip="Publish Quiz"
              color="green"
              popconfirmProps={{
                title: 'Publish Quiz',
                description: 'This will make the quiz available to all students.',
                onConfirm: e => {
                  e.stopPropagation();
                  handlePublishQuiz(record.id);
                },
                okText: 'Publish',
                cancelText: 'Cancel',
              }}
            />
          )}
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div>
      {/* Outlet renders child routes (preview drawer) */}
      <Outlet />

      <div className=" flex justify-between items-start">
        <PageHeader title="Quiz Management" routeName="quizzes" />

        <Space>
          <Popconfirm
            title="Clear All My Attempts"
            description="This will delete all your quiz attempts across all quizzes. This cannot be undone."
            onConfirm={handleClearMyAttempts}
            okText="Clear All"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
          >
            <Button icon={<IconTrash size={16} />}>Clear My Attempts</Button>
          </Popconfirm>

          <Button
            type="primary"
            icon={<IconPlus size={16} />}
            onClick={() => navigate(`/admin/${classSlug}/quizzes/form`)}
          >
            New Quiz
          </Button>
        </Space>
      </div>

      <div className="space-y-6">
        <div className="mt-4">
          <Table
            columns={columns}
            dataSource={quizzes}
            rowKey={record => record.id}
            rowHoverable={false}
            size="middle"
            pagination={{
              pageSize: 25,
              showSizeChanger: true,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} quizzes`,
            }}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} className="font-semibold">
                  Total
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1}></Table.Summary.Cell>
                <Table.Summary.Cell index={2} className="font-bold">
                  <span
                    className={
                      totalWeight === 100
                        ? 'text-green-600'
                        : totalWeight > 100
                          ? 'text-red-600'
                          : 'text-orange-600'
                    }
                  >
                    {totalWeight}%
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3}></Table.Summary.Cell>
                <Table.Summary.Cell index={4}></Table.Summary.Cell>
                <Table.Summary.Cell index={5}></Table.Summary.Cell>
                <Table.Summary.Cell index={6}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
            locale={{
              emptyText: (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-4xl mb-2">🤖</div>
                  <div>No quizzes created yet</div>
                  <div className="text-sm">Create your first AI-powered quiz to get started!</div>
                </div>
              ),
            }}
            className="rounded-lg"
          />
        </div>
      </div>
    </div>
  );
}
