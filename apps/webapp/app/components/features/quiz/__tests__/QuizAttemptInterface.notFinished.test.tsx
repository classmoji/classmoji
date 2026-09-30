// @vitest-environment jsdom
/**
 * QuizAttemptInterface when the server will not complete an attempt yet.
 *
 * The chat marks the quiz complete as soon as a reply carries the evaluation,
 * locks the input and asks the server to complete the attempt. The server
 * completes it only once every question has a recorded result; otherwise it
 * answers 409 QUIZ_NOT_FINISHED and leaves the attempt open. The chat then
 * reopens: the input unlocks, the evaluation card goes, the server's line
 * shows after the transcript, and that evaluation is not taken as the end of
 * the quiz again. A later evaluation completes the quiz as usual.
 *
 * The evaluation card is shown for a completed attempt only: the latest
 * evaluation's feedback, with the scores and per-question results the attempt
 * has stored — also after the drawer is closed and opened again.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidate = vi.fn();

vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate }) }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
// The editor, reduced to whether it is disabled.
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ disabled }: { disabled: boolean }) => (
    <output data-testid="disabled">{String(disabled)}</output>
  ),
}));
vi.mock('~/components/features/quiz/QuizMessageList', () => ({
  default: ({
    messages,
    isQuizComplete,
    evaluationData,
  }: {
    messages: { id: string | number; content: string }[];
    isQuizComplete: boolean;
    evaluationData: unknown;
  }) => (
    <>
      <output data-testid="complete">{String(isQuizComplete)}</output>
      <output data-testid="card">{JSON.stringify(evaluationData)}</output>
      <ul>
        {messages.map(m => (
          <li key={m.id}>{m.content}</li>
        ))}
      </ul>
    </>
  ),
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizAttemptInterface } = await import('../QuizAttemptInterface');

const QUIZ = { id: 'quiz-1', question_count: 3 };
const ATTEMPT = { id: 'attempt-1', total_duration_ms: 0, unfocused_duration_ms: 0 };

const NOT_FINISHED_LINE = "This quiz isn't finished yet. Send a message to continue.";

const evaluation = (id: string, band = 'GOOD') => ({
  id,
  role: 'assistant',
  content:
    'Great work!\n\n[QUIZ_EVALUATION]\n```json\n' +
    `{"quiz_complete": true, "evaluation": "${band}", "numeric_score": 3, ` +
    '"partial_credit_percentage": 100, "first_attempt_percentage": 100}\n```',
  metadata: {},
});
const QUESTION_3 = {
  id: 'm1',
  role: 'assistant',
  content: '**Question 3 of 3** What is a closure?',
  metadata: { isOpeningMessage: true },
};
const ANSWER = { id: 'm2', role: 'user', content: 'a function with its scope' };
const FIRST_EVALUATION = evaluation('m3');
const CONTINUE = { id: 'm4', role: 'user', content: 'continue' };
const SECOND_EVALUATION = evaluation('m5', 'EXCELLENT');

/** The same attempt once the server has completed it, with its stored scores. */
const COMPLETED_ATTEMPT = {
  ...ATTEMPT,
  completed_at: '2026-09-29T12:00:00.000Z',
  partial_credit_percentage: 66.7,
  first_attempt_percentage: 33.3,
  question_results: [
    { question_num: 1, attempts: 1, credit_earned: 100, eventually_correct: true },
    { question_num: 2, attempts: 3, credit_earned: 60, eventually_correct: true },
    { question_num: 3, attempts: 2, credit_earned: 40, eventually_correct: true },
  ],
};

const fetchMock = vi.fn();
let completeStatus: number;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  completeStatus = 409;
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { _action } = JSON.parse(init.body as string);
    if (_action === 'completeQuiz' && completeStatus === 409) {
      return new Response(
        JSON.stringify({ success: false, code: 'QUIZ_NOT_FINISHED', message: NOT_FINISHED_LINE }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
};

const render = async (
  messages: unknown[],
  { attempt = ATTEMPT as Record<string, unknown>, readOnly = false } = {}
) => {
  await act(async () => {
    root.render(
      <QuizAttemptInterface
        quiz={QUIZ}
        attempt={attempt}
        messages={messages as never[]}
        userLogin="ada"
        readOnly={readOnly}
      />
    );
  });
  await settle();
};

/** Closes the drawer and opens it again: a fresh component instance. */
const remount = async () => {
  act(() => root.unmount());
  root = createRoot(container);
};

const completeCalls = () =>
  fetchMock.mock.calls.filter(
    ([, init]) => JSON.parse((init as RequestInit).body as string)._action === 'completeQuiz'
  );
const disabled = () => container.querySelector('[data-testid="disabled"]')?.textContent;
const complete = () => container.querySelector('[data-testid="complete"]')?.textContent;
const lines = () => Array.from(container.querySelectorAll('li')).map(li => li.textContent);
const card = () =>
  JSON.parse(container.querySelector('[data-testid="card"]')?.textContent || 'null') as Record<
    string,
    unknown
  > | null;

describe('QuizAttemptInterface — completion refused because the quiz is not finished', () => {
  it('reopens the chat, shows the line, and does not ask again for the same evaluation', async () => {
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION]);

    expect(completeCalls()).toHaveLength(1);
    expect(disabled()).toBe('false');
    expect(complete()).toBe('false');
    expect(lines()).toContain(NOT_FINISHED_LINE);

    // The transcript is re-read (a revalidation): same evaluation, no new ask.
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION]);
    expect(completeCalls()).toHaveLength(1);
    expect(disabled()).toBe('false');
    expect(lines()).toContain(NOT_FINISHED_LINE);
  });

  it('completes on a later evaluation once the server accepts it', async () => {
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION]);
    expect(disabled()).toBe('false');

    completeStatus = 200;
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION, CONTINUE, SECOND_EVALUATION]);

    expect(completeCalls()).toHaveLength(2);
    expect(disabled()).toBe('true');
    expect(complete()).toBe('true');
    // The transcript grew, so the line is gone.
    expect(lines()).not.toContain(NOT_FINISHED_LINE);
  });

  it('stays complete when the server completes the attempt', async () => {
    completeStatus = 200;
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION]);

    expect(completeCalls()).toHaveLength(1);
    expect(disabled()).toBe('true');
    expect(complete()).toBe('true');
    expect(lines()).not.toContain(NOT_FINISHED_LINE);
  });
});

describe('QuizAttemptInterface — the evaluation card', () => {
  it('shows no card until the attempt is completed', async () => {
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION]);
    expect(card()).toBeNull();
  });

  it('after a refusal and a later completion, shows the latest evaluation with the stored scores on reopening', async () => {
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION]);
    expect(disabled()).toBe('false');

    await remount();
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION, CONTINUE, SECOND_EVALUATION], {
      attempt: COMPLETED_ATTEMPT,
      readOnly: true,
    });

    // Already complete: nothing more is sent.
    expect(completeCalls()).toHaveLength(1);
    expect(complete()).toBe('true');
    expect(card()).toMatchObject({
      evaluation: 'EXCELLENT',
      partial_credit_percentage: 66.7,
      first_attempt_percentage: 33.3,
      total_questions: 3,
    });
    expect((card()?.question_results as unknown[]).length).toBe(3);
  });

  it('shows the stored scores in the staff viewer of a completed attempt', async () => {
    await render([QUESTION_3, ANSWER, FIRST_EVALUATION], {
      attempt: COMPLETED_ATTEMPT,
      readOnly: true,
    });

    expect(completeCalls()).toHaveLength(0);
    expect(card()).toMatchObject({ evaluation: 'GOOD', partial_credit_percentage: 66.7 });
  });
});
