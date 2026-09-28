// @vitest-environment jsdom
/**
 * QuizAttemptInterface when a message is refused because the attempt's
 * previous turn is still running (the ai-agent's turn_in_progress; prod,
 * 2026-09-28). The server saves "Your last message is still being answered."
 * and answers the send with `awaitingReply`. The chat used to unlock and stop
 * polling there, so the running turn's reply appeared only on a reload, and
 * the student typed the answer again — graded as a second attempt. It now
 * keeps the input locked and the transcript polling until that turn ends.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidate = vi.fn();

vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate }) }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
// The editor, reduced to what this test reads: whether it is locked, and a send.
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ onSubmit, loading }: { onSubmit: (content: string) => void; loading: boolean }) => (
    <>
      <output data-testid="locked">{String(loading)}</output>
      <button data-testid="send" onClick={() => onSubmit('my answer again')} />
    </>
  ),
}));
vi.mock('~/components/features/quiz/QuizMessageList', () => ({
  default: ({ messages }: { messages: { id: string | number; content: string }[] }) => (
    <ul>
      {messages.map(m => (
        <li key={m.id}>{m.content}</li>
      ))}
    </ul>
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

const QUESTION_1 = {
  id: 'm1',
  role: 'assistant',
  content: '**Question 1 of 5** What does useState return?',
  metadata: { isOpeningMessage: true },
};
const ANSWER = { id: 'm2', role: 'user', content: 'a pair' };
const STILL_ANSWERING = {
  id: 'm3',
  role: 'assistant',
  content: 'Your last message is still being answered.',
  metadata: { errorType: 'AGENT_FAILURE', code: 'turn_in_progress' },
};
const REPLY = {
  id: 'm4',
  role: 'assistant',
  content: 'Right. **Question 2 of 5** What is a closure?',
  metadata: {},
};

const fetchMock = vi.fn();
let sendReply: Record<string, unknown>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sendReply = { success: false, error: 'Agent failure', awaitingReply: true };
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { _action } = JSON.parse(init.body as string);
    const body = _action === 'sendMessage' ? sendReply : { success: true };
    return new Response(JSON.stringify(body), {
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
  vi.useRealTimers();
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

const locked = () => container.querySelector('[data-testid="locked"]')?.textContent;
const lines = () => Array.from(container.querySelectorAll('li')).map(li => li.textContent);
const send = async () => {
  await act(async () => {
    (container.querySelector('[data-testid="send"]') as HTMLButtonElement).click();
  });
  await settle();
};

describe('QuizAttemptInterface — a message sent while the last one is still being answered', () => {
  it('stays locked and shows the line until the running turn’s reply arrives', async () => {
    await render([QUESTION_1, ANSWER]);
    expect(locked()).toBe('false');

    await send();
    // Refused: the input stays locked, and the transcript is re-read.
    expect(locked()).toBe('true');
    expect(revalidate).toHaveBeenCalled();

    // The revalidation brings the saved line; still waiting.
    await render([QUESTION_1, ANSWER, STILL_ANSWERING]);
    expect(lines()).toContain(STILL_ANSWERING.content);
    expect(lines()).not.toContain('my answer again');
    expect(locked()).toBe('true');

    // The running turn's reply lands: unlocked.
    await render([QUESTION_1, ANSWER, STILL_ANSWERING, REPLY]);
    expect(lines()).toContain(REPLY.content);
    expect(locked()).toBe('false');
  });

  it('keeps polling while it waits', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await render([QUESTION_1, ANSWER]);
    await send();
    await render([QUESTION_1, ANSWER, STILL_ANSWERING]);

    revalidate.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(4_500);
    });
    expect(revalidate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('unlocks when the running turn ends in a failure line of its own', async () => {
    await render([QUESTION_1, ANSWER]);
    await send();
    await render([QUESTION_1, ANSWER, STILL_ANSWERING]);
    expect(locked()).toBe('true');

    await render([
      QUESTION_1,
      ANSWER,
      STILL_ANSWERING,
      {
        id: 'm5',
        role: 'assistant',
        content: "That reply couldn't be finished. Please send your message again.",
        metadata: { errorType: 'AGENT_FAILURE', code: 'TURN_DEADLINE' },
      },
    ]);
    expect(locked()).toBe('false');
  });

  it('gives up waiting after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    await render([QUESTION_1, ANSWER]);
    await send();
    await render([QUESTION_1, ANSWER, STILL_ANSWERING]);
    expect(locked()).toBe('true');

    await act(async () => {
      vi.advanceTimersByTime(299_000);
    });
    expect(locked()).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(locked()).toBe('false');
  });

  it('unlocks at once after an ordinary send', async () => {
    sendReply = { success: true };
    await render([QUESTION_1, ANSWER]);
    await send();
    expect(locked()).toBe('false');
  });
});
