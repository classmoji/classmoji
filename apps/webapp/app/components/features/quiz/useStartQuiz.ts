import { useCallback, useState } from 'react';
import { useLocation, useNavigate, useRevalidator } from 'react-router';
import { Modal } from 'antd';

/** What /api/quiz's restartQuiz (and a failed startQuiz) answers with. */
interface RestartQuizBody {
  success?: boolean;
  attemptId?: string;
  reason?: string;
  existingAttemptId?: string;
  message?: string;
}

const RESTART_FAILED = "Couldn't start a new attempt. Please try again.";

/**
 * The JSON body of an /api/quiz reply, or null when there is none to read. A
 * gate can answer with plain text, so a body that is not a JSON object counts
 * as no body rather than an exception thrown into the page.
 */
const readJsonBody = async (response: Response): Promise<RestartQuizBody | null> => {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as RestartQuizBody) : null;
  } catch {
    return null;
  }
};

/**
 * The server's own message when it sent one (restartQuiz, or the startQuiz
 * that follows it), otherwise ours. The server only sends fixed copy — among
 * it the QUIZZES_UNAVAILABLE refusal a page left open gets once the class no
 * longer has quizzes — so it is safe to show as is.
 */
const restartFailureCopy = (body: RestartQuizBody | null) =>
  typeof body?.message === 'string' && body.message.trim() ? body.message : RESTART_FAILED;

/**
 * Starting a quiz attempt: ask /api/quiz for a new attempt (restartQuiz), start
 * it (startQuiz), then open it. An attempt already in progress is offered for
 * resuming instead. Shared by the student quiz list and the dashboard's Up
 * next card, so both start an attempt the same way.
 *
 * The attempt page lives under the prefix the viewer arrived on (/student,
 * /assistant, …), taken from the current URL.
 */
export const useStartQuiz = (classSlug: string) => {
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const [startingQuizId, setStartingQuizId] = useState<string | null>(null);

  const rolePrefix = location.pathname.split('/')[1];
  const attemptPath = useCallback(
    (quizId: string, attemptId: string) =>
      `/${rolePrefix}/${classSlug}/quizzes/${quizId}/attempt/${attemptId}`,
    [rolePrefix, classSlug]
  );

  /**
   * Start a new attempt on `quizId`. `repoName` is the repository staff
   * preview a code-aware quiz against; students pass null.
   */
  const startQuiz = useCallback(
    async (quizId: string, repoName: string | null = null) => {
      setStartingQuizId(quizId);
      try {
        const response = await fetch('/api/quiz', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _action: 'restartQuiz', quizId, repoName }),
        });

        const result = await readJsonBody(response);

        if (!result?.success) {
          // An attempt already in progress: offer to resume it.
          if (result?.reason === 'incomplete_attempt_exists' && result.existingAttemptId) {
            const existingAttemptId = result.existingAttemptId;
            Modal.confirm({
              title: 'Resume or Start New?',
              content: 'You have an in-progress attempt. Would you like to resume it?',
              okText: 'Resume',
              cancelText: 'Cancel',
              onOk: () => {
                navigate(attemptPath(quizId, existingAttemptId));
              },
            });
            return;
          }
          Modal.error({ title: 'Cannot Start Quiz', content: restartFailureCopy(result) });
          return;
        }

        const startResponse = await fetch('/api/quiz', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _action: 'startQuiz', quizId, attemptId: result.attemptId }),
        });

        if (!startResponse.ok) {
          // The new attempt may still exist though it didn't start, so the page
          // shows it. (One refused for its source material has been removed.)
          revalidator.revalidate();
          Modal.error({
            title: 'Cannot Start Quiz',
            content: restartFailureCopy(await readJsonBody(startResponse)),
          });
          return;
        }

        navigate(attemptPath(quizId, result.attemptId!));
      } catch (error: unknown) {
        // The raw error stays in the console; the page only ever shows fixed copy.
        console.error('Error creating new attempt:', error);
        Modal.error({ title: 'Cannot Start Quiz', content: RESTART_FAILED });
      } finally {
        setStartingQuizId(null);
      }
    },
    [attemptPath, navigate, revalidator]
  );

  /** Open an attempt that is already running. */
  const resumeQuiz = useCallback(
    (quizId: string, attemptId: string) => navigate(attemptPath(quizId, attemptId)),
    [attemptPath, navigate]
  );

  return { startQuiz, resumeQuiz, startingQuizId };
};
