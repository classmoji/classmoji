import { useMemo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import type { Route } from './+types/route';
import { QuizAttemptInterface } from '~/components';
import { QuizAttemptScreen } from '~/components/features/quiz-attempt';
import type { ExplorationStepData } from '~/components/features/quiz-attempt';
import { assertClassroomAccess } from '~/utils/helpers';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { ClassmojiService } = await import('@classmoji/services');
  const classSlug = params.class!;
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;

  // 1. Authenticate and authorize
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'ASSISTANT', 'OWNER'],
    resourceType: 'QUIZ_ATTEMPT',
    attemptedAction: 'view',
  });

  // 2. Fetch quiz
  const quiz = await ClassmojiService.quiz.findById(quizId);
  if (!quiz || quiz.classroom_id.toString() !== classroom.id.toString()) {
    throw new Response('Quiz not found', { status: 404 });
  }

  // 3. Fetch attempt with messages
  const attemptData = await ClassmojiService.quizAttempt.findWithMessages(attemptId);
  if (!attemptData?.attempt) {
    throw new Response('Attempt not found', { status: 404 });
  }

  // 4. Verify ownership (students can only view their own attempts)
  const isInstructor = membership
    ? ['OWNER', 'ASSISTANT', 'TEACHER'].includes(membership.role)
    : false;
  if (!isInstructor && attemptData.attempt.user_id.toString() !== userId.toString()) {
    throw new Response('Unauthorized', { status: 403 });
  }

  // 5. Calculate focus metrics for completed attempts
  const totalMs = Number(attemptData.attempt.total_duration_ms || 0);
  const unfocusedMs = Number(attemptData.attempt.unfocused_duration_ms || 0);
  const focusedMs = Math.max(0, totalMs - unfocusedMs);
  const focusPercentage = totalMs > 0 ? Math.round((focusedMs / totalMs) * 100) : 100;

  const focusMetrics = {
    totalMs,
    focusedMs,
    percentage: focusPercentage,
  };

  // 6. Determine if read-only (completed attempt)
  const readOnly = Boolean(attemptData.attempt.completed_at);

  // 7. Strip sensitive fields from attempt before sending to client
  // agent_config may contain API keys - never expose to browser
  // quiz.classroom.settings contains anthropic_api_key, openai_api_key
  const { agent_config: _agent_config, ...attemptWithoutConfig } = attemptData.attempt;
  const safeAttempt = {
    ...attemptWithoutConfig,
    quiz: {
      ...attemptWithoutConfig.quiz,
      classroom: attemptWithoutConfig.quiz?.classroom
        ? { ...attemptWithoutConfig.quiz.classroom, settings: undefined }
        : undefined,
    },
  };

  return {
    quiz,
    attempt: safeAttempt,
    // Use unified messages from getAttemptWithMessages (ai-agent owns persistence)
    messages: attemptData.messages || [],
    userLogin: safeAttempt.user?.login || null,
    isAdmin: isInstructor,
    readOnly,
    showTimestamps: false,
    focusMetrics,
    org: classSlug,
  };
}

interface QuizLike {
  id?: unknown;
  name?: string;
  question_count?: number;
  time_limit_minutes?: number;
  code_aware_mode?: boolean;
  [key: string]: unknown;
}

interface MessageLike {
  role?: string;
  content?: string;
  metadata?: Record<string, unknown> | null | unknown;
  timestamp?: string | Date;
}

function getMetaRecord(metadata: unknown): Record<string, unknown> | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return null;
}

/**
 * Map an ai-agent tool invocation to a simple {kind, path, detail} step shape
 * for the redesigned exploration rail.
 */
function toExplorationStep(msg: MessageLike): ExplorationStepData | null {
  const meta = getMetaRecord(msg.metadata);
  if (!meta) return null;
  if (!meta.isExplorationStep) return null;

  const toolName = typeof meta.toolName === 'string' ? meta.toolName.toLowerCase() : '';
  let kind: ExplorationStepData['kind'] = 'read';
  if (toolName.includes('grep')) kind = 'grep';
  else if (toolName.includes('glob') || toolName.includes('list')) kind = 'glob';
  else if (toolName.includes('read') || toolName.includes('view')) kind = 'read';
  else if (toolName) kind = toolName.slice(0, 4);

  const input = (meta.toolInput ?? {}) as Record<string, unknown>;
  const path =
    (typeof input.path === 'string' && input.path) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    msg.content ||
    '';

  return {
    kind,
    path: String(path),
    detail: '',
  };
}

export default function StudentQuizAttemptScreen({ loaderData }: Route.ComponentProps) {
  const data = loaderData;
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const location = useLocation();
  const [showConfirm, setShowConfirm] = useState(false);

  const rolePrefix = location.pathname.split('/')[1];

  const navigateAway = () => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes`);
  };

  const handleClose = () => {
    if (!data.readOnly) {
      setShowConfirm(true);
    } else {
      navigateAway();
    }
  };

  const handleConfirmLeave = () => {
    setShowConfirm(false);
    navigateAway();
  };

  const quiz = data.quiz as QuizLike;
  const messages = (data.messages ?? []) as MessageLike[];

  // Derive current question number and exploration steps from the latest messages.
  const { questionNumber, explorationSteps } = useMemo(() => {
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    // Count opening message + subsequent non-welcome assistant messages as questions
    const questionCount = assistantMessages.filter(m => {
      const meta = getMetaRecord(m.metadata);
      if (!meta) return false;
      if (meta.isWelcomeMessage) return false;
      return true;
    }).length;

    const steps = messages
      .filter(m => m.role === 'system')
      .map(toExplorationStep)
      .filter((s): s is ExplorationStepData => Boolean(s));

    return {
      questionNumber: Math.max(1, questionCount || 1),
      explorationSteps: steps,
    };
  }, [messages]);

  const questionTotal = typeof quiz.question_count === 'number' ? quiz.question_count : null;
  const progress =
    questionTotal && questionTotal > 0
      ? Math.min(1, questionNumber / questionTotal)
      : 0;

  const isCodeAware = Boolean(quiz.code_aware_mode);
  const timeLimitMs =
    typeof quiz.time_limit_minutes === 'number' ? quiz.time_limit_minutes * 60_000 : null;
  const focusPercentage = data.focusMetrics?.percentage ?? null;
  const elapsedMs = data.focusMetrics?.totalMs ?? null;

  return (
    <>
      <QuizAttemptScreen
        chipLabel="Quiz"
        title={quiz.name ?? 'Quiz'}
        isCodeAware={isCodeAware}
        questionNumber={data.readOnly ? null : questionNumber}
        questionTotal={questionTotal}
        readOnly={data.readOnly}
        focusPercentage={focusPercentage}
        progress={progress}
        elapsedMs={elapsedMs}
        timeLimitMs={timeLimitMs}
        explorationSteps={explorationSteps}
        onClose={handleClose}
      >
        <QuizAttemptInterface {...data} onClose={handleClose} isVisible={true} />
      </QuizAttemptScreen>

      {showConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowConfirm(false)}
        >
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: 420,
              width: '100%',
              padding: 20,
              background: 'white',
              boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
            }}
          >
            <h3
              className="display"
              style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}
            >
              Leave quiz?
            </h3>
            <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--ink-2)' }}>
              Your quiz is still in progress. Are you sure you want to leave?
            </p>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--ink-3)' }}>
              Your progress has been saved and you can resume later.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn"
                onClick={() => setShowConfirm(false)}
              >
                Continue quiz
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmLeave}
              >
                Yes, leave
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
