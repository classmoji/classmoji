// @vitest-environment jsdom
/**
 * QuizAttemptInterface stops waiting when the transcript ends in a failure line.
 *
 * A start refused for unavailable source material can leave ONE assistant
 * line (metadata.errorType) and no welcome message: the refusal comes before
 * the agent and its conversation exist. (A brand-new attempt refused that way
 * is now removed and its start answers 409 instead; the line is what an
 * attempt with history gets.) The chat used to read "exactly one assistant
 * message, no opening question" as "welcome shown, question 1 still coming",
 * keep its spinner and poll forever. A line carrying `errorType` is final:
 * nothing more is coming for it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidate = vi.fn();

vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate }) }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));
vi.mock('~/components/features/quiz/QuizMessageList', () => ({
  default: ({
    messages,
    loading,
  }: {
    messages: { id: string | number; content: string }[];
    loading: boolean;
  }) => (
    <>
      <output data-testid="loading">{String(loading)}</output>
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

const QUIZ = { id: 'quiz-1', question_count: 5 };
const ATTEMPT = { id: 'attempt-1', total_duration_ms: 0, unfocused_duration_ms: 0 };
const NO_MESSAGES: never[] = [];

const UNAVAILABLE = {
  id: 'msg-1',
  role: 'assistant',
  content: "This quiz's source material isn't available yet. Ask your instructor.",
  metadata: { errorType: 'SOURCE_MATERIAL_UNAVAILABLE' },
};
const WELCOME = {
  id: 'msg-0',
  role: 'assistant',
  content: 'Welcome!',
  metadata: { isWelcomeMessage: true },
};

const fetchMock = vi.fn();
/** The start/send actions posted (focus bookkeeping like recordModalOpen aside). */
const actions = () =>
  fetchMock.mock.calls
    .map(([, init]) => JSON.parse((init as RequestInit).body as string)._action)
    .filter((action: string) => action === 'startQuiz' || action === 'sendMessage');

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ attemptId: ATTEMPT.id }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
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

const loading = () => container.querySelector('[data-testid="loading"]')?.textContent;
const lines = () => Array.from(container.querySelectorAll('li')).map(li => li.textContent);

describe('QuizAttemptInterface — a transcript that ends in a failure line', () => {
  it('stops loading when the background start saves the unavailable line', async () => {
    await render(NO_MESSAGES);
    expect(actions()).toEqual(['startQuiz']);
    expect(loading()).toBe('true');

    // The revalidation after the refused init delivers the one saved line.
    await render([UNAVAILABLE]);

    expect(lines()).toEqual([UNAVAILABLE.content]);
    expect(loading()).toBe('false');
  });

  it('does not start waiting again when the attempt is reopened later', async () => {
    await render([UNAVAILABLE]);

    expect(loading()).toBe('false');
    // It has a real message, so nothing is (re)started either.
    expect(actions()).toEqual([]);
  });

  it('still waits after a welcome alone (question 1 is on its way)', async () => {
    await render([WELCOME]);

    expect(loading()).toBe('true');
  });
});
