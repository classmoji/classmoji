// @vitest-environment jsdom
/**
 * Focus time across a refused completion, with the real useQuizFocusMetrics.
 *
 * When a reply carries the evaluation, the chat sends completeQuiz with the
 * time so far. If the server answers 409 QUIZ_NOT_FINISHED the chat reopens
 * and the clock runs again, so the next completeQuiz carries the time spent
 * before AND after the refusal.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidate = vi.fn();

vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate }) }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ disabled }: { disabled: boolean }) => (
    <output data-testid="disabled">{String(disabled)}</output>
  ),
}));
vi.mock('~/components/features/quiz/QuizMessageList', () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizAttemptInterface } = await import('../QuizAttemptInterface');

const QUIZ = { id: 'quiz-1', question_count: 3 };
const ATTEMPT = { id: 'attempt-1', total_duration_ms: 0, unfocused_duration_ms: 0 };

const evaluation = (id: string) => ({
  id,
  role: 'assistant',
  content: 'Done!\n\n[QUIZ_EVALUATION]\n```json\n{"quiz_complete": true}\n```',
  metadata: {},
});
const QUESTION_3 = {
  id: 'm1',
  role: 'assistant',
  content: '**Question 3 of 3** What is a closure?',
  metadata: { isOpeningMessage: true },
};
const ANSWER = { id: 'm2', role: 'user', content: 'a function with its scope' };

let now = 1_000_000;
const fetchMock = vi.fn();
let completeStatus = 409;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  completeStatus = 409;
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { _action } = JSON.parse(init.body as string);
    if (_action === 'completeQuiz' && completeStatus === 409) {
      return new Response(
        JSON.stringify({ success: false, code: 'QUIZ_NOT_FINISHED', message: 'Not yet.' }),
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

const render = async (messages: unknown[]) => {
  await act(async () => {
    root.render(
      <QuizAttemptInterface
        quiz={QUIZ}
        attempt={ATTEMPT}
        messages={messages as never[]}
        userLogin="ada"
      />
    );
  });
  await settle();
};

const completeBodies = () =>
  fetchMock.mock.calls
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
    .filter(body => body._action === 'completeQuiz');

describe('QuizAttemptInterface — focus time across a refused completion', () => {
  it('keeps counting after the refusal and sends the whole time with the next completion', async () => {
    await render([QUESTION_3, ANSWER]);

    now += 10_000;
    await render([QUESTION_3, ANSWER, evaluation('m3')]);
    expect(completeBodies()).toHaveLength(1);
    expect(completeBodies()[0].totalDurationMs).toBe(10_000);
    expect(container.querySelector('[data-testid="disabled"]')?.textContent).toBe('false');

    // The student keeps working after the chat reopens.
    now += 7_000;
    completeStatus = 200;
    await render([
      QUESTION_3,
      ANSWER,
      evaluation('m3'),
      { id: 'm4', role: 'user', content: 'continue' },
      evaluation('m5'),
    ]);

    expect(completeBodies()).toHaveLength(2);
    expect(completeBodies()[1].totalDurationMs).toBe(17_000);
  });
});
