import { useFetcher, useLocation, useNavigate, useParams, Outlet } from 'react-router';
import { Table, Button, Typography, Tag, Space, Tooltip, Popconfirm } from 'antd';
import { IconSend, IconBook, IconCalendar, IconTrash } from '@tabler/icons-react';
import { TableActionButtons, EditableCell, ButtonNew } from '~/components';
import { ClassmojiService, QuizAccessError } from '@classmoji/services';
import { namedAction } from 'remix-utils/named-action';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
  assertProTier,
} from '~/utils/helpers';
import type { Route } from './+types/route';
import type React from 'react';
import type { TablerIconsProps } from '@tabler/icons-react';

const { Text } = Typography;

interface AdminQuiz {
  id: string;
  name: string;
  moduleId: string | null;
  moduleTitle: string;
  systemPrompt: string | null;
  rubricPrompt: string | null;
  subject: string;
  difficultyLevel: string;
  dueDate: string | Date | null;
  status: string;
  weight: number;
  questionCount: number;
  maxAttempts: number;
  gradingStrategy: string;
  includeCodeContext: boolean;
  attemptsCount: number;
  avgScore: number | null;
  attemptStatus: string | null;
  score: number | null;
  userAttempt: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface ActionButtonProps {
  icon: React.ComponentType<TablerIconsProps>;
  tooltip: string;
  color?: string;
  onClick?: () => void;
  popconfirmProps?: Record<string, unknown>;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_ACCESS',
    attemptedAction: 'view_admin_quizzes',
  });

  await assertProTier(classSlug);

  // Get classroom settings
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  // Check if quizzes are enabled for this classroom
  if (settings?.quizzes_enabled === false) {
    throw new Response('Quizzes are currently disabled for this classroom', { status: 403 });
  }

  const user = await ClassmojiService.user.findById(userId);

  // Get all quizzes for admin (including drafts).
  //
  // The service keeps its own role list, so it can disagree with the gate above
  // — and when it did, its bare Error surfaced as a 500 rather than a refusal.
  // A QuizAccessError is always a refusal, so it is answered as one: a future
  // role gap between the two lists fails visibly instead of looking like a
  // server fault.
  let quizzesWithAttempts;
  try {
    quizzesWithAttempts = await ClassmojiService.quiz.findByClassroom(classroom.id, membership);
  } catch (error) {
    if (error instanceof QuizAccessError) {
      throw new Response('You do not have access to this classroom’s quizzes', { status: 403 });
    }
    throw error;
  }

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
      moduleId: quiz.repository_id?.toString() || null,
      moduleTitle: quiz.repository?.title || 'Unlinked',
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

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const data = await request.json();

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_ACTION',
    attemptedAction: data._action || 'unknown',
    metadata: {
      quiz_id: data.id || null,
    },
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
  await assertProTier(classSlug);

  // Create FormData with the action from the JSON
  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  // Each branch audits once its write has landed, under the MCP quiz tools'
  // resource_type ('QUIZ') and keyed on the quiz id. The AuditLogAction enum
  // has no PUBLISH, so publish and weight changes are UPDATE with the intent
  // carried in `tool` — which is also what stops the audit service's 5-second
  // dedup from folding a publish and a weight change into one row.
  const audit = (action: string, resourceId: string, metadata: Record<string, unknown>) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action,
      resourceType: 'QUIZ',
      resourceId,
      metadata,
    });

  const notFound = () =>
    new Response(JSON.stringify({ error: 'Quiz not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

  /**
   * Resolve a quiz THAT BELONGS TO THE CLASSROOM THIS REQUEST WAS AUTHORIZED
   * FOR, or answer 404.
   *
   * Authorization binds to `params.class`, but the quiz id arrives in the JSON
   * body and `quiz.service` resolves quizzes by id alone — so without this the
   * two are unrelated and a caller authorized for one classroom could name a
   * quiz in another. Every mutation below proves the classroom BEFORE it writes
   * and before it audits, which is also what keeps the audit row truthful: a
   * row naming this classroom must describe a write that landed here.
   *
   * Same check the MCP quiz tools make via `loadQuizInClassroom`
   * (apps/mcp/src/tools/shared.ts), and the same uniform rejection: an unknown
   * id and another classroom's quiz are indistinguishable to the caller.
   */
  const loadQuizInClassroom = async (quizId: string) => {
    if (!quizId) return null;
    const quiz = await ClassmojiService.quiz.findById(quizId);
    return quiz && quiz.classroom_id === classroom.id ? quiz : null;
  };

  /**
   * Resolve a repository id supplied in the body against this classroom.
   *
   * `quiz.create`/`quiz.update` connect the repository relation by id with no
   * classroom check of their own, so an id from another classroom would link
   * across the boundary. Absent/null is legitimate (an unlinked quiz) and
   * passes through; a NAMED repository must live in this classroom.
   */
  const resolveRepositoryId = async (repositoryId: unknown) => {
    if (repositoryId === undefined || repositoryId === null || repositoryId === '') {
      return { ok: true as const, value: repositoryId };
    }
    const repository = await ClassmojiService.repository.findById(String(repositoryId));
    if (!repository || repository.classroom_id !== classroom.id) {
      return { ok: false as const, value: null };
    }
    return { ok: true as const, value: repositoryId };
  };

  return namedAction(formData, {
    async createQuiz() {
      const { ...quizData } = data;
      const repository = await resolveRepositoryId(quizData.repositoryId);
      if (!repository.ok) return notFound();
      const newQuiz = await ClassmojiService.quiz.create({
        ...quizData,
        classroomId: classroom.id,
      });
      await audit('CREATE', newQuiz.id, {
        tool: 'web:quizzes.create',
        name: newQuiz.name,
        repository_id: newQuiz.repository_id ?? null,
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
      if (!(await loadQuizInClassroom(data.id))) return notFound();
      const repository = await resolveRepositoryId(data.repositoryId);
      if (!repository.ok) return notFound();
      await ClassmojiService.quiz.update(data.id, data);
      await audit('UPDATE', data.id, {
        tool: 'web:quizzes.update',
        // Field NAMES only. The body carries system and rubric prompts, which
        // are long free text and do not belong in an audit payload.
        fields: Object.keys(data).filter(key => key !== '_action' && key !== 'id'),
      });
      return new Response(JSON.stringify({ success: 'Quiz updated successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async deleteQuiz() {
      const quiz = await loadQuizInClassroom(data.id);
      if (!quiz) return notFound();
      await ClassmojiService.quiz.delete(data.id);
      await audit('DELETE', data.id, { tool: 'web:quizzes.delete', name: quiz.name });
      return new Response(JSON.stringify({ success: 'Quiz deleted successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async publishQuiz() {
      if (!(await loadQuizInClassroom(data.id))) return notFound();
      await ClassmojiService.quiz.publish(data.id);
      await audit('UPDATE', data.id, { tool: 'web:quizzes.publish', published: true });
      return new Response(JSON.stringify({ success: 'Quiz published successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async updateWeight() {
      if (!(await loadQuizInClassroom(data.id))) return notFound();
      await ClassmojiService.quiz.update(data.id, {
        weight: data.weight,
      });
      await audit('UPDATE', data.id, {
        tool: 'web:quizzes.update_weight',
        fields: ['weight'],
        weight: data.weight,
      });
      return new Response(JSON.stringify({ success: 'Quiz weight updated successfully' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },

    async clearMyAttempts() {
      // Takes no id from the body: the service scopes the delete by BOTH the
      // caller's user id and this classroom, so there is nothing here for a
      // request body to redirect at another classroom.
      const result = await ClassmojiService.quizAttempt.clearForUser(userId, classroom.id);
      // Classroom-wide clear of the caller's OWN preview attempts, so it is not
      // keyed on any one quiz — the classroom is the affected resource.
      await audit('DELETE', classroom.id, {
        tool: 'web:quizzes.clear_my_attempts',
        scope: 'classroom',
        deleted_count: result.deletedCount,
      });
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

export default function AdminQuizzes({ loaderData }: Route.ComponentProps) {
  const { quizzes } = loaderData;
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  // Served under every prefix this route's gate allows (/admin and /teacher),
  // so links stay on the prefix the user arrived on.
  const rolePrefix = useLocation().pathname.split('/')[1];

  const handleEditQuiz = (quiz: AdminQuiz) => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes/form?quizId=${quiz.id}`);
  };

  const handleDeleteQuiz = (quizId: string) => {
    fetcher.submit(
      { _action: 'deleteQuiz', id: quizId },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handleUpdateWeight = (
    quizId: string | number,
    weight: string | number | null | undefined
  ) => {
    fetcher.submit(
      {
        _action: 'updateWeight',
        id: String(quizId),
        weight: Number(weight ?? 0),
      },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handlePublishQuiz = (quizId: string) => {
    fetcher.submit(
      { _action: 'publishQuiz', id: quizId },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handleClearMyAttempts = () => {
    fetcher.submit({ _action: 'clearMyAttempts' }, { method: 'POST', encType: 'application/json' });
  };

  const handleViewQuiz = (quiz: AdminQuiz) => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes/${quiz.id}`);
  };

  const totalWeight = quizzes
    .filter(q => (q.status as string) !== 'ARCHIVED')
    .reduce((acc: number, q) => acc + q.weight, 0);

  const ActionButton = ({
    icon: Icon,
    tooltip,
    color = 'gray',
    onClick,
    popconfirmProps,
  }: ActionButtonProps) => {
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
        <Popconfirm {...popconfirmProps} title={popconfirmProps.title as string}>
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
      width: 240,
      sorter: (a: AdminQuiz, b: AdminQuiz) => a.name.localeCompare(b.name),
      render: (name: string) => <span className="font-medium text-ink-1">{name}</span>,
    },
    {
      title: 'Repository',
      dataIndex: 'moduleTitle',
      key: 'repository',
      width: 240,
      sorter: (a: AdminQuiz, b: AdminQuiz) => a.moduleTitle.localeCompare(b.moduleTitle),
      render: (title: string) => (
        <Space>
          <IconBook size={16} className="text-gray-400" />
          <Text type="secondary">{title}</Text>
        </Space>
      ),
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: 110,
      sorter: (a: AdminQuiz, b: AdminQuiz) => a.weight - b.weight,
      render: (quiz: AdminQuiz) => (
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
      width: 150,
      sorter: (a: AdminQuiz, b: AdminQuiz) => {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      },
      render: (dueDate: string | null) =>
        dueDate ? (
          <Space>
            <IconCalendar size={16} className="text-gray-400" />
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
      width: 110,
      sorter: (a: AdminQuiz, b: AdminQuiz) => a.status.localeCompare(b.status),
      render: (status: string) => {
        const statusConfig: Record<string, { color: string; text: string }> = {
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
      width: 110,
      render: (_: unknown, record: AdminQuiz) =>
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
      render: (_: unknown, record: AdminQuiz) => (
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
                onConfirm: (e?: React.MouseEvent) => {
                  e?.stopPropagation();
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
    <div className="min-h-full relative">
      <Outlet />

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Quizzes</h1>

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

          <ButtonNew action={() => navigate(`/${rolePrefix}/${classSlug}/quizzes/form`)}>
            New quiz
          </ButtonNew>
        </Space>
      </div>

      <div className="rounded-2xl overflow-hidden bg-panel ring-1 ring-line min-h-[calc(100vh-10rem)] p-5 sm:p-6">
        <Table
          columns={columns}
          dataSource={quizzes as readonly AdminQuiz[]}
          rowKey={record => record.id}
          rowHoverable={false}
          size="middle"
          scroll={{ x: 'max-content' }}
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
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No quizzes created yet</div>
                <div className="text-sm">Create your first quiz to get started!</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
}
