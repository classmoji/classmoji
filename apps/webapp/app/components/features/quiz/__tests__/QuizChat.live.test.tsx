// @vitest-environment jsdom
/**
 * The live chat's behaviour: a new attempt starts with the typed `begin`
 * action (through useChat, so its turn renders like any reply), a resumed or
 * started one does not start again, button clicks send the buttons' fixed
 * text, the transport's two callbacks both ask the session route, and the
 * drawer is refreshed once the attempt can take no more turns.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUTTON_TEXT, type QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
const revalidateMock = vi.fn();
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: revalidateMock }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({
    onSubmit,
    sendButtonTestId,
  }: {
    onSubmit: (t: string) => void;
    sendButtonTestId?: string;
  }) => (
    <button data-testid={sendButtonTestId} onClick={() => onSubmit('my answer')}>
      Send
    </button>
  ),
}));
let metrics = { totalMs: 0, unfocusedMs: 0 };
const snapshot = () => metrics;
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

const chatState: { messages: QuizUIMessage[]; status: string; error?: unknown } = {
  messages: [],
  status: 'ready',
};
const sendMessageMock = vi.fn();
const sendActionMock = vi.fn();
const useChatOptions: Array<Record<string, unknown>> = [];
vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, unknown>) => {
    useChatOptions.push(options);
    return { ...chatState, sendMessage: sendMessageMock };
  },
}));
let transportOptions: Record<string, (...a: unknown[]) => unknown> | null = null;
let transportInstance: Record<string, unknown> = {};
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: (options: Record<string, (...a: unknown[]) => unknown>) => {
    transportOptions = options;
    return transportInstance;
  },
  useChatActions: () => ({ sendAction: sendActionMock }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// antd reads media queries; jsdom has none.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= () => {};

const { default: QuizChat, QuizChatSessionError } = await import('../QuizChat');
const { formatDuration } = await import('~/utils/quizUtils');

const ATTEMPT = { id: 'attempt-1', completed_at: null, evaluation_json: null };
const QUIZ = { id: 'quiz-1', question_count: 8 };

const buttonsMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Not quite.' },
    {
      type: 'tool-offer_next_step',
      toolCallId: 'c1',
      state: 'output-available',
      input: { actions: ['try_again', 'next'] },
      output: { actions: ['try_again', 'next'] },
    },
  ],
} as unknown as QuizUIMessage;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

const mount = async (transcript: QuizUIMessage[]) => {
  await act(async () => {
    root.render(
      <QuizChat quiz={QUIZ} attempt={ATTEMPT} transcript={transcript} viewerOwnsAttempt />
    );
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  chatState.messages = [];
  chatState.status = 'ready';
  chatState.error = undefined;
  revalidateMock.mockReset();
  metrics = { totalMs: 0, unfocusedMs: 0 };
  sendMessageMock.mockReset();
  sendActionMock.mockReset().mockResolvedValue(undefined);
  useChatOptions.length = 0;
  transportOptions = null;
  transportInstance = {};
  window.sessionStorage.clear();
  fetchMock
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('QuizChat live', () => {
  it('starts a new attempt with the begin action, once', async () => {
    await mount([]);

    expect(sendActionMock).toHaveBeenCalledTimes(1);
    expect(sendActionMock).toHaveBeenCalledWith({ type: 'begin' });
    expect(useChatOptions[0]).toMatchObject({ id: 'attempt-1', resume: false });
  });

  it('does not start an attempt that already has a transcript', async () => {
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);

    expect(sendActionMock).not.toHaveBeenCalled();
  });

  it('resumes a reply this tab was streaming instead of starting again', async () => {
    window.sessionStorage.setItem(
      'classmoji:quiz-chat-session:attempt-1',
      JSON.stringify({ publicAccessToken: 'pat', isStreaming: true })
    );
    await mount([]);

    expect(sendActionMock).not.toHaveBeenCalled();
    expect(useChatOptions[0]).toMatchObject({ resume: true });
    expect(transportOptions).toMatchObject({
      sessions: { 'attempt-1': { publicAccessToken: 'pat', isStreaming: true } },
    });
  });

  it("sends the buttons' fixed text as the student's message", async () => {
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);

    const tryAgain = container.querySelector('[data-testid="quiz-try-again"]') as HTMLButtonElement;
    await act(async () => tryAgain.click());
    expect(sendMessageMock).toHaveBeenCalledWith({ text: BUTTON_TEXT.try_again });

    const next = container.querySelector('[data-testid="quiz-next"]') as HTMLButtonElement;
    await act(async () => next.click());
    expect(sendMessageMock).toHaveBeenCalledWith({ text: BUTTON_TEXT.next });
  });

  it('keeps the buttons usable after a side question, and a click then sends as before', async () => {
    const sideChat = [
      buttonsMessage,
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: "Why won't you grade that?" }],
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The question asks about layout.' }],
      },
    ] as unknown as QuizUIMessage[];
    chatState.messages = sideChat;
    await mount(sideChat);

    const next = container.querySelector('[data-testid="quiz-next"]') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    await act(async () => next.click());
    expect(sendMessageMock).toHaveBeenCalledWith({ text: BUTTON_TEXT.next });

    sendMessageMock.mockReset();
    const tryAgain = container.querySelector('[data-testid="quiz-try-again"]') as HTMLButtonElement;
    await act(async () => tryAgain.click());
    expect(sendMessageMock).toHaveBeenCalledWith({ text: BUTTON_TEXT.try_again });
  });

  it("ends a hint with Next alone, whose click sends Next's fixed text", async () => {
    const hinted = [
      buttonsMessage,
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: BUTTON_TEXT.try_again }] },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: "Here's a hint. What do you think?" }],
      },
    ] as unknown as QuizUIMessage[];
    chatState.messages = hinted;
    await mount(hinted);

    // The offer's set is used up; the hint's Next is the only button left usable.
    const usable = [...container.querySelectorAll('button')].filter(
      b => b.closest('[data-testid="quiz-next-step"]') && !b.disabled
    );
    expect(usable.map(b => b.getAttribute('data-testid'))).toEqual(['quiz-next']);
    await act(async () => usable[0].click());
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({ text: BUTTON_TEXT.next });
  });

  it('sends the editor text, and nothing while a reply is running', async () => {
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);
    const send = container.querySelector('[data-testid="quiz-send"]') as HTMLButtonElement;
    await act(async () => send.click());
    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'my answer' });

    sendMessageMock.mockReset();
    chatState.status = 'streaming';
    await mount([buttonsMessage]);
    await act(async () => send.click());
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('asks the session route for both the start and the token refresh', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/quiz-chat/session'
        ? new Response(JSON.stringify({ publicAccessToken: 'pat-9' }), { status: 200 })
        : new Response('{}', { status: 200 })
    );
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);

    const started = await transportOptions!.startSession({
      chatId: 'attempt-1',
      taskId: 'quiz-attempt',
    });
    const refreshed = await transportOptions!.accessToken({ chatId: 'attempt-1' });

    expect(started).toEqual({ publicAccessToken: 'pat-9' });
    expect(refreshed).toBe('pat-9');
    const sessionCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/quiz-chat/session');
    expect(sessionCalls).toHaveLength(2);
    expect(JSON.parse(sessionCalls[0][1].body)).toEqual({ attemptId: 'attempt-1' });
  });

  it("opens a tab's first reply stream at the session route's resume cursor", async () => {
    const seedResumeCursor = vi.fn();
    transportInstance = { seedResumeCursor };
    let answer: Record<string, unknown> = { publicAccessToken: 'pat-9', resumeCursor: '1234' };
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/quiz-chat/session'
        ? new Response(JSON.stringify(answer), { status: 200 })
        : new Response('{}', { status: 200 })
    );
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);

    const start = () =>
      transportOptions!.startSession({ chatId: 'attempt-1', taskId: 'quiz-attempt' });
    expect(await start()).toEqual({ publicAccessToken: 'pat-9' });
    expect(seedResumeCursor).toHaveBeenCalledWith('attempt-1', '1234');

    // No cursor (a new session), or a malformed one: nothing is seeded.
    seedResumeCursor.mockReset();
    answer = { publicAccessToken: 'pat-9' };
    await start();
    answer = { publicAccessToken: 'pat-9', resumeCursor: '12; drop' };
    await start();
    expect(seedResumeCursor).not.toHaveBeenCalled();

    // A token refresh never moves the cursor.
    answer = { publicAccessToken: 'pat-9', resumeCursor: '99' };
    expect(await transportOptions!.accessToken({ chatId: 'attempt-1' })).toBe('pat-9');
    expect(seedResumeCursor).not.toHaveBeenCalled();
  });

  it("carries the session route's fixed copy on a refusal, and nothing else", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/quiz-chat/session'
        ? new Response(
            JSON.stringify({ code: 'QUIZ_COMPLETE', message: 'This quiz is already complete.' }),
            { status: 409 }
          )
        : new Response('{}', { status: 200 })
    );
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);

    await expect(transportOptions!.accessToken({ chatId: 'attempt-1' })).rejects.toThrow(
      'This quiz is already complete.'
    );

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ message: 'raw internal detail' }), { status: 500 })
    );
    await expect(transportOptions!.accessToken({ chatId: 'attempt-1' })).rejects.toThrow(
      "The quiz couldn't start. Please try again."
    );
  });

  it('sends the final time once, when the attempt completes', async () => {
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);
    const metricPosts = () =>
      fetchMock.mock.calls
        .filter(([url]) => url === '/api/quiz')
        .map(([, init]) => JSON.parse((init as RequestInit).body as string))
        .filter(body => body._action === 'updateMetrics');
    expect(metricPosts()).toHaveLength(0);

    // The closing reply carries the evaluation: the attempt is complete.
    metrics = { totalMs: 42_000, unfocusedMs: 50_000 };
    chatState.messages = [
      buttonsMessage,
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          {
            type: 'data-evaluation',
            data: {
              v: 2,
              source: 'server',
              partial_credit_percentage: 70,
              first_attempt_percentage: 0,
              question_results: [],
            },
          },
        ],
      } as unknown as QuizUIMessage,
    ];
    await mount([buttonsMessage]);
    await mount([buttonsMessage]);

    expect(metricPosts()).toEqual([
      {
        _action: 'updateMetrics',
        attemptId: 'attempt-1',
        totalDurationMs: 42_000,
        // Never more time away than time in total.
        unfocusedDurationMs: 42_000,
      },
    ]);
  });

  const evaluationMessage = {
    id: 'a2',
    role: 'assistant',
    parts: [
      {
        type: 'data-evaluation',
        data: {
          v: 2,
          source: 'server',
          partial_credit_percentage: 70,
          first_attempt_percentage: 0,
          question_results: [],
        },
      },
    ],
  } as unknown as QuizUIMessage;

  const render = async (
    attempt: Record<string, unknown>,
    focusMetrics: Record<string, number> | null = null
  ) => {
    await act(async () => {
      root.render(
        <QuizChat
          quiz={QUIZ}
          attempt={attempt as never}
          transcript={[buttonsMessage]}
          viewerOwnsAttempt
          focusMetrics={focusMetrics as never}
        />
      );
    });
  };
  const editor = () => container.querySelector('[data-testid="quiz-editor"]');

  it('takes the editor away once the evaluation is in', async () => {
    chatState.messages = [buttonsMessage];
    await render(ATTEMPT);
    expect(editor()).not.toBeNull();
    expect(container.querySelector('[data-testid="quiz-send"]')).not.toBeNull();

    chatState.messages = [buttonsMessage, evaluationMessage];
    await render(ATTEMPT);
    expect(editor()).toBeNull();
    expect(container.querySelector('[data-testid="quiz-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="quiz-results"]')).not.toBeNull();
  });

  it('takes the editor away when the refreshed attempt is complete, after mount', async () => {
    chatState.messages = [buttonsMessage];
    await render(ATTEMPT);
    expect(editor()).not.toBeNull();

    // The drawer's refresh brings the attempt back completed.
    await render({ ...ATTEMPT, completed_at: '2026-09-30T12:00:00Z' });
    expect(editor()).toBeNull();
  });

  it("shows the time from this tab's final count, not the refresh's stored value", async () => {
    chatState.messages = [buttonsMessage];
    const stale = { totalMs: 60_000, focusedMs: 60_000, percentage: 100 };
    await render(ATTEMPT, stale);

    metrics = { totalMs: 125_000, unfocusedMs: 5_000 };
    chatState.messages = [buttonsMessage, evaluationMessage];
    await render(ATTEMPT, stale);
    // The drawer refreshes with the stored time, read before the last write landed.
    await render({ ...ATTEMPT, completed_at: '2026-09-30T12:00:00Z' }, stale);

    const results = container.querySelector('[data-testid="quiz-results"]')!;
    expect(results.textContent).toContain(`Total: ${formatDuration(125_000)}`);
    expect(results.textContent).toContain(`Focused: ${formatDuration(120_000)}`);
    expect(results.textContent).toContain('96% Time on Page');
    expect(results.textContent).not.toContain(`Total: ${formatDuration(60_000)}`);
  });

  it('shows the time it was given while the attempt was never completed here', async () => {
    chatState.messages = [buttonsMessage, evaluationMessage];
    const stored = { totalMs: 60_000, focusedMs: 30_000, percentage: 50 };
    await render(ATTEMPT, stored);
    const results = container.querySelector('[data-testid="quiz-results"]')!;
    expect(results.textContent).toContain(`Total: ${formatDuration(60_000)}`);
    expect(results.textContent).toContain('50% Time on Page');
  });

  it('refreshes the drawer once, after the reply, when the session closes', async () => {
    chatState.messages = [buttonsMessage];
    chatState.status = 'streaming';
    await mount([buttonsMessage]);

    await act(async () => {
      transportOptions!.onSessionChange('attempt-1', { publicAccessToken: 'pat' });
    });
    expect(revalidateMock).not.toHaveBeenCalled();

    // A permanent refusal: the task closes the session, and the turn ends in an error.
    await act(async () => {
      transportOptions!.onSessionChange('attempt-1', { publicAccessToken: 'pat', closed: true });
    });
    expect(revalidateMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem('classmoji:quiz-chat-session:attempt-1')!)
    ).toEqual({ publicAccessToken: 'pat', closed: true });

    chatState.status = 'error';
    chatState.error = new Error('This attempt has reached its message limit.');
    await mount([buttonsMessage]);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
    // Nothing more can be sent.
    expect(container.querySelector('[data-testid="quiz-editor"]')!.className).toContain(
      'pointer-events-none'
    );

    await mount([buttonsMessage]);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the drawer when the session route refuses the attempt for good, only then', async () => {
    chatState.messages = [buttonsMessage];
    chatState.status = 'error';
    chatState.error = new QuizChatSessionError(
      "Quizzes aren't available in this class.",
      'QUIZZES_UNAVAILABLE'
    );
    await mount([buttonsMessage]);
    expect(revalidateMock).not.toHaveBeenCalled();

    chatState.error = new QuizChatSessionError('This quiz is already complete.', 'QUIZ_COMPLETE');
    await mount([buttonsMessage]);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the session state per tab', async () => {
    chatState.messages = [buttonsMessage];
    await mount([buttonsMessage]);

    await act(async () => {
      transportOptions!.onSessionChange('attempt-1', { publicAccessToken: 'pat-2' });
    });
    expect(
      JSON.parse(window.sessionStorage.getItem('classmoji:quiz-chat-session:attempt-1')!)
    ).toEqual({ publicAccessToken: 'pat-2' });

    await act(async () => {
      transportOptions!.onSessionChange('attempt-1', null);
    });
    expect(window.sessionStorage.getItem('classmoji:quiz-chat-session:attempt-1')).toBeNull();
  });
});
