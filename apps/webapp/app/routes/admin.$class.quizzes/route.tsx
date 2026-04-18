import { useNavigate, useParams, Outlet } from 'react-router';
import dayjs from 'dayjs';
import { Button, IconPlus } from '@classmoji/ui-components';
import { ClassmojiService } from '@classmoji/services';
import { namedAction } from 'remix-utils/named-action';
import { assertClassroomAccess } from '~/utils/helpers';
import {
  AssignmentsScreen,
  type AssignmentRowData,
  type AssignmentState,
} from '~/components/features/assignments';
import type { Route } from './+types/route';

interface AdminQuiz {
  id: string;
  name: string;
  moduleId: string | null;
  moduleTitle: string;
  dueDate: string | Date | null;
  status: string;
  weight: number;
  attemptsCount: number;
  avgScore: number | null;
  [key: string]: unknown;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'ADMIN_QUIZ_ACCESS',
    attemptedAction: 'view_admin_quizzes',
  });

  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  if (settings?.quizzes_enabled === false) {
    throw new Response('Quizzes are currently disabled for this classroom', { status: 403 });
  }

  const user = await ClassmojiService.user.findById(userId);

  const quizzesWithAttempts = await ClassmojiService.quiz.findByClassroom(classroom.id, membership);

  const transformedQuizzes = quizzesWithAttempts.map(quiz => {
    const adminAttempt = quiz.attempts?.find(a => String(a.user_id) === String(userId));
    let attemptStatus: string | null = null;
    let score: number | null = null;

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
      id: quiz.id,
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

function formatDue(due: string | Date | null | undefined): string {
  if (!due) return '';
  const d = dayjs(due);
  return d.isValid() ? d.format('MMM D') : '';
}

function deriveAdminState(quiz: AdminQuiz): AssignmentState {
  if (quiz.status === 'DRAFT') return 'draft';
  if (quiz.status === 'ARCHIVED') return 'closed';
  const due = quiz.dueDate ? dayjs(quiz.dueDate) : null;
  if (due && due.isValid() && due.isAfter(dayjs().add(2, 'day'))) return 'upcoming';
  return 'open';
}

export default function AdminQuizzes({ loaderData }: Route.ComponentProps) {
  const { quizzes, org } = loaderData;
  const navigate = useNavigate();
  const { class: classSlug } = useParams();

  const rows: AssignmentRowData[] = (quizzes as AdminQuiz[]).map(q => ({
    id: String(q.id),
    slug: String(q.id),
    href: `/admin/${classSlug || org}/quizzes/${q.id}`,
    kind: 'QUIZ',
    title: q.name,
    mod: q.moduleTitle === 'Unlinked' ? '' : q.moduleTitle,
    due: formatDue(q.dueDate),
    state: deriveAdminState(q),
  }));

  return (
    <div>
      <Outlet />
      <AssignmentsScreen
        title="Quiz management"
        assignments={rows}
        headerActions={
          <Button
            variant="primary"
            onClick={() => navigate(`/admin/${classSlug || org}/quizzes/form`)}
          >
            <IconPlus size={14} /> New quiz
          </Button>
        }
        emptyState="No quizzes yet. Create your first one!"
      />
    </div>
  );
}
