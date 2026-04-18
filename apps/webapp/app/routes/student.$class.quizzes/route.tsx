import { Outlet, useLocation } from 'react-router';
import dayjs from 'dayjs';
import { gradeToEmoji, getEmojiSymbol } from '@classmoji/utils';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import {
  AssignmentsScreen,
  type AssignmentRowData,
  type AssignmentState,
} from '~/components/features/assignments';

interface QuizAttempt {
  id: string;
  attemptNumber: number;
  status: string;
  partialCreditScore: number | null;
  completed_at: string | Date | null;
  isCounting: boolean;
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

  const [quizzes, user, emojiMappings] = await Promise.all([
    ClassmojiService.quiz.getQuizzesForStudent(classroom.id, userId, membership),
    ClassmojiService.user.findById(userId),
    ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
  ]);

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

      attemptCount: quiz.attemptCount || 0,
      attempts: quiz.attempts || [],
      attemptsSummary: quiz.attemptsSummary || {},

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
    emojiMappings: emojiMappings as Record<string, number>,
  };
}

function formatDue(due: string | Date | null | undefined): string {
  if (!due) return '';
  const d = dayjs(due);
  return d.isValid() ? d.format('MMM D') : '';
}

function deriveStudentState(
  quiz: StudentQuiz,
  emojiMappings: Record<string, number>
): {
  state: AssignmentState;
  pct?: number | null;
  emoji?: string | null;
} {
  const completed = quiz.attempts.find(a => a.status === 'completed');
  if (completed) {
    const pct = quiz.attemptsSummary?.currentScore ?? completed.partialCreditScore ?? null;
    const hasMappings = emojiMappings && Object.keys(emojiMappings).length > 0;
    const emoji =
      pct !== null && pct !== undefined && hasMappings
        ? getEmojiSymbol(gradeToEmoji(pct, emojiMappings))
        : null;
    return { state: 'graded', pct, emoji };
  }
  const due = quiz.dueDate ? dayjs(quiz.dueDate) : null;
  if (due && due.isValid() && due.isAfter(dayjs().add(2, 'day'))) {
    return { state: 'upcoming' };
  }
  return { state: 'open' };
}

export default function StudentQuizzes({ loaderData }: Route.ComponentProps) {
  const { quizzes: rawQuizzes, org, emojiMappings } = loaderData;
  const quizzes = rawQuizzes as unknown as StudentQuiz[];
  const location = useLocation();
  const rolePrefix = location.pathname.split('/')[1] || 'student';

  const published = quizzes.filter(q => q.status === 'PUBLISHED');

  const rows: AssignmentRowData[] = published.map(q => {
    const { state, pct, emoji } = deriveStudentState(q, emojiMappings ?? {});
    return {
      id: String(q.id),
      slug: String(q.id),
      href: `/${rolePrefix}/${org}/quizzes/${q.id}`,
      kind: 'QUIZ',
      title: q.name,
      mod: q.assignmentTitle === 'Unlinked' ? '' : q.assignmentTitle,
      due: formatDue(q.dueDate),
      state,
      pct,
      emoji,
    };
  });

  return (
    <div className="relative">
      <Outlet />
      <AssignmentsScreen assignments={rows} />
    </div>
  );
}
