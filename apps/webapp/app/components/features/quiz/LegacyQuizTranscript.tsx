import { useEffect, useMemo } from 'react';
import type { Prisma } from '@prisma/client';
import { checkForCompletion } from '~/utils/quizUtils';
import type { QuizEvaluation } from '@classmoji/utils';
import { useDarkMode } from '~/hooks';
import QuizMessageList from './QuizMessageList';

/**
 * The read-only view of an attempt from the retired ai-agent runtime
 * (`agent_runtime: 'ai_agent'`), for the student who sat it and for staff.
 *
 * It only shows what was saved: the transcript, and for a completed attempt
 * the evaluation card with the attempt's stored scores. Nothing here sends
 * anything: no start, no messages, no completion, no time tracking, no
 * polling. An attempt that was never finished stays unfinished and says it
 * can no longer be continued; the student starts a new attempt from the quiz
 * list instead (within the quiz's max_attempts).
 */

/** Shown under an unfinished attempt in place of the message box. */
export const LEGACY_ATTEMPT_CLOSED_LINE = 'This attempt can no longer be continued.';

/** Metadata shape for quiz messages */
interface QuizMessageMetadata {
  explorationSteps?: {
    action: string;
    toolName?: string;
    tool?: string;
    title?: string;
  }[];
  [key: string]: unknown;
}

/** Safely extract metadata as a record from Prisma JsonValue */
function getMetadata(metadata: Prisma.JsonValue | undefined): QuizMessageMetadata | undefined {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as QuizMessageMetadata;
  }
  return undefined;
}

/** Shape of a saved quiz message */
interface QuizMessage {
  id: number | string;
  role: string;
  content: string;
  metadata?: Prisma.JsonValue;
  timestamp?: string | Date;
}

/** The latest assistant message carrying an evaluation, with its parsed evaluation. */
const lastEvaluationIn = (displayMessages: QuizMessage[]): QuizEvaluation | null => {
  for (let i = displayMessages.length - 1; i >= 0; i--) {
    const msg = displayMessages[i];
    if (msg.role?.toLowerCase() !== 'assistant') continue;
    const completion = checkForCompletion(msg.content);
    if (completion) return completion;
  }
  return null;
};

/**
 * The evaluation card's data for a completed attempt: the feedback text from
 * the evaluation message, and the scores and per-question results the attempt
 * has stored (see ~/utils/quizPayloads, attemptDrawerView). No number in the
 * message itself is shown.
 */
const evaluationWithStoredScores = (
  completion: QuizEvaluation,
  attempt: Record<string, unknown>
): QuizEvaluation => {
  const {
    partial_credit_percentage: _partial,
    first_attempt_percentage: _firstAttempt,
    raw_percentage: _raw,
    percentage: _percentage,
    total_questions: _total,
    question_results: _results,
    ...feedback
  } = completion as QuizEvaluation & Record<string, unknown>;
  const results = Array.isArray(attempt.question_results) ? attempt.question_results : [];
  // The stored scores only where the drawer sent them (staff); a student's
  // attempt carries none (E1), and none is made up here.
  const scores = Object.fromEntries(
    (['partial_credit_percentage', 'first_attempt_percentage'] as const).flatMap(key =>
      typeof attempt[key] === 'number' ? [[key, attempt[key]]] : []
    )
  );
  return {
    ...feedback,
    ...scores,
    question_results: results,
    total_questions: results.length,
  } as unknown as QuizEvaluation;
};

/** Focus metrics for display */
interface FocusMetrics {
  totalMs: number;
  focusedMs: number;
  percentage: number;
}

export interface LegacyQuizTranscriptProps {
  attempt: Record<string, unknown> | null;
  messages?: QuizMessage[];
  userLogin: string | null;
  userImage?: string | null;
  focusMetrics?: FocusMetrics | null;
}

function LegacyQuizTranscript({
  attempt,
  messages = [],
  userLogin,
  userImage = null,
  focusMetrics = null,
}: LegacyQuizTranscriptProps) {
  const { isDarkMode } = useDarkMode();
  const completed = Boolean(attempt?.completed_at);

  // Dynamically load highlight.js theme based on dark mode
  useEffect(() => {
    document.querySelector('link[data-hljs-theme]')?.remove();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-hljs-theme', 'true');
    link.href = isDarkMode
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
    document.head.appendChild(link);
    return () => {
      document.querySelector('link[data-hljs-theme]')?.remove();
    };
  }, [isDarkMode]);

  // SYSTEM rows are the saved exploration steps; the assistant messages carry
  // their own collapsed copy.
  const displayMessages = useMemo(
    () => (messages || []).filter(m => m.role?.toLowerCase() !== 'system'),
    [messages]
  );

  // The evaluation card, for a completed attempt only: the latest evaluation's
  // feedback with the attempt's stored scores.
  const evaluationData = useMemo(() => {
    if (!completed || !attempt) return null;
    const latest = lastEvaluationIn(displayMessages);
    return latest ? evaluationWithStoredScores(latest, attempt) : null;
  }, [completed, attempt, displayMessages]);

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      data-testid="legacy-quiz-transcript"
    >
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <QuizMessageList
          messages={displayMessages.map(m => ({ ...m, metadata: getMetadata(m.metadata) }))}
          isDarkMode={isDarkMode}
          userLogin={userLogin}
          userImage={userImage}
          evaluationData={evaluationData}
          focusMetrics={focusMetrics}
        />
      </div>

      {!completed && (
        <div
          className="mt-4 border-t border-gray-100 pt-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
          data-testid="legacy-quiz-closed"
        >
          {LEGACY_ATTEMPT_CLOSED_LINE}
        </div>
      )}
    </div>
  );
}

export default LegacyQuizTranscript;
