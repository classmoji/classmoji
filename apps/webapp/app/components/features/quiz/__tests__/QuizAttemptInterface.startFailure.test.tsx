// @vitest-environment jsdom
/**
 * QuizAttemptInterface when a start or a send fails, MOUNTED in jsdom.
 *
 * An attempt with no messages yet is started by an effect that POSTs
 * startQuiz. When that POST fails, the chat shows the failure line and the
 * start is NOT sent again on its own: reopening the attempt or reloading the
 * page starts it again. (It used to re-POST in a loop: the catch reset the
 * guard that stops a second start, and the transcript sync that runs when
 * loading stops wiped the failure line, so the effect saw an empty chat again.)
 *
 * A failed send (a refusal, a failed reply) shows the student's own line and a
 * failure line after the saved transcript. The transcript sync that runs when
 * sending stops, and every revalidation after it, keeps them there until the
 * saved transcript has messages it didn't have when the send failed.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidate = vi.fn();

vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate }) }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ onSubmit }: { onSubmit: (content: string) => void }) => (
    <button type="button" data-testid="send" onClick={() => onSubmit('My answer')} />
  ),
}));
vi.mock('~/components/features/quiz/QuizMessageList', () => ({
  default: ({
    messages,
    onQuickAction,
  }: {
    messages: { id: string | number; content: string }[];
    onQuickAction: ((action: string) => void) | null;
  }) => (
    <>
      <ul>
        {messages.map(m => (
          <li key={m.id}>{m.content}</li>
        ))}
      </ul>
      {onQuickAction && (
        <button type="button" data-testid="quick" onClick={() => onQuickAction('Next question')} />
      )}
    </>
  ),
}));
// Stable references, as the real hook's useCallbacks are: the component lists
// them in effect dependencies.
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizAttemptInterface } = await import('../QuizAttemptInterface');

const QUIZ = { id: 'quiz-1', question_count: 5 };
const ATTEMPT = { id: 'attempt-1', total_duration_ms: 0, unfocused_duration_ms: 0 };
// One array for every render: the component re-syncs from it when it changes.
const NO_MESSAGES: never[] = [];

const START_FAILED = "The quiz couldn't start. Please try again.";
const REFUSAL = "Quizzes aren't available in this class.";
const UNAVAILABLE = "This quiz's source material isn't available yet. Ask your instructor.";
const OPENING = {
  id: 'msg-1',
  role: 'assistant',
  content: 'Question 1 of 5: What does a closure capture?',
  metadata: { isOpeningMessage: true },
};

const fetchMock = vi.fn();

const actions = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)._action);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answer each /api/quiz action with the given reply; any other action succeeds. */
const replyTo = (replies: Record<string, () => Response>) =>
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { _action } = JSON.parse(init.body as string);
    return replies[_action]?.() ?? json({ success: true });
  });

const refused = () => json({ success: false, code: 'QUIZZES_UNAVAILABLE', message: REFUSAL }, 403);

/** The chat's lines, in order. */
const lines = () => Array.from(container.querySelectorAll('li')).map(li => li.textContent);

/** Let the POST settle and the effects it sets off run. */
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
  replyTo({
    startQuiz: () =>
      json({ success: false, error: 'Something went wrong. Please try again.' }, 500),
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

/** Render with this transcript, as the first load or as a revalidation. */
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

const mount = () => render(NO_MESSAGES);

const click = async (testId: string) => {
  await act(async () => {
    container
      .querySelector(`[data-testid="${testId}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};

describe('QuizAttemptInterface — a failed automatic start', () => {
  it('sends startQuiz once and does not send it again on its own', async () => {
    await mount();

    expect(actions().filter(a => a === 'startQuiz')).toEqual(['startQuiz']);
  });

  it('shows the fixed start-failure line', async () => {
    await mount();

    expect(container.textContent).toContain(START_FAILED);
    expect(container.textContent).not.toContain('500');
  });

  it("shows the server's own message when it sent one", async () => {
    replyTo({ startQuiz: refused });

    await mount();

    expect(container.textContent).toContain(REFUSAL);
    expect(actions().filter(a => a === 'startQuiz')).toHaveLength(1);
  });

  it('shows a source-material refusal and does not poll for a question', async () => {
    // The start's 409 when nothing linked is available, or when the ai-agent
    // refused the init and the attempt was removed.
    replyTo({
      startQuiz: () =>
        json(
          {
            success: false,
            code: 'SOURCE_MATERIAL_UNAVAILABLE',
            message: UNAVAILABLE,
            error: UNAVAILABLE,
          },
          409
        ),
    });

    await mount();
    expect(lines()).toEqual([UNAVAILABLE]);

    // Polling runs every 1.5s while the chat waits; it must not be waiting.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1700));
    });
    expect(revalidate).not.toHaveBeenCalled();
    expect(actions().filter(a => a === 'startQuiz')).toHaveLength(1);
  });

  it('keeps the line when a revalidation delivers a new, still empty transcript', async () => {
    await mount();

    await render([]);

    expect(lines()).toEqual([START_FAILED]);
    expect(actions().filter(a => a === 'startQuiz')).toHaveLength(1);
  });

  it('replaces the line with the saved messages once they arrive', async () => {
    await mount();

    await render([OPENING]);

    expect(lines()).toEqual([OPENING.content]);
  });
});

describe('QuizAttemptInterface — a successful automatic start', () => {
  it('fetches the transcript and shows the opening message', async () => {
    replyTo({ startQuiz: () => json({ success: true }) });

    await mount();
    expect(revalidate).toHaveBeenCalled();

    await render([OPENING]);

    expect(lines()).toEqual([OPENING.content]);
    expect(actions().filter(a => a === 'startQuiz')).toHaveLength(1);
  });
});

describe('QuizAttemptInterface — a failed send', () => {
  beforeEach(() => {
    replyTo({ sendMessage: refused });
  });

  it("keeps the student's line and the refusal once sending stops", async () => {
    await render([OPENING]);

    await click('send');

    expect(actions().filter(a => a === 'sendMessage')).toHaveLength(1);
    expect(lines()).toEqual([OPENING.content, 'My answer', REFUSAL]);
  });

  it('keeps them when a revalidation delivers the unchanged transcript', async () => {
    await render([OPENING]);
    await click('send');

    // A new array holding the same saved rows.
    await render([{ ...OPENING }]);

    expect(lines()).toEqual([OPENING.content, 'My answer', REFUSAL]);
  });

  it('drops them once the transcript has a message it did not have', async () => {
    await render([OPENING]);
    await click('send');

    const reply = { id: 'msg-3', role: 'assistant', content: 'Right. Question 2 of 5: ...' };
    await render([OPENING, { id: 'msg-2', role: 'user', content: 'My answer' }, reply]);

    expect(lines()).toEqual([OPENING.content, 'My answer', reply.content]);
  });

  it('keeps the same pair for a refused quick action', async () => {
    await render([OPENING]);

    await click('quick');
    await render([{ ...OPENING }]);

    expect(lines()).toEqual([OPENING.content, 'Next question', REFUSAL]);
  });

  it('drops them when the next send starts', async () => {
    await render([OPENING]);
    await click('send');

    replyTo({ sendMessage: () => json({ success: true }) });
    await click('send');

    expect(container.textContent).not.toContain(REFUSAL);
  });
});
