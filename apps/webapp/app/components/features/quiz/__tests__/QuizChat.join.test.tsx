// @vitest-environment jsdom
/**
 * Opening an attempt in a second tab or window while its opening turn runs
 * in the first. The opening was admitted (the loader finds its stored rows:
 * `chatStarted`), but its reply is saved only when the turn ends, so the
 * transcript is still empty. Sending begin again would start a second opening
 * or be refused ("This quiz has already started.", with a Start again that is
 * refused the same way). This tab joins the running reply instead: it reads
 * the reply stream from its start, or, when there is nothing to read, waits
 * for the saved transcript.
 *
 * The real useChat and useChatActions run under StrictMode (the webapp's
 * client entry) over a fake Trigger transport.
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
const revalidateMock = vi.fn();
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: revalidateMock }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ sendButtonTestId }: { sendButtonTestId?: string }) => (
    <button data-testid={sendButtonTestId}>Send</button>
  ),
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

const WELCOME = 'Welcome to your quiz! I will be asking you 8 questions.';
const QUESTION = 'Question one: why flexbox?';

/** The opening reply as its stream carries it, from its start. */
const OPENING: UIMessageChunk[] = [
  { type: 'start', messageId: 'opening-reply' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: WELCOME },
  { type: 'text-end', id: 't1' },
  { type: 'text-start', id: 't2' },
  { type: 'text-delta', id: 't2', delta: QUESTION },
  { type: 'text-end', id: 't2' },
  { type: 'finish' },
];

/** The same reply as the transcript holds it once saved. */
const SAVED: QuizUIMessage[] = [
  {
    id: 'opening-reply',
    role: 'assistant',
    parts: [
      { type: 'text', text: WELCOME },
      { type: 'text', text: QUESTION },
    ],
  } as QuizUIMessage,
];

const streamOf = (chunks: readonly UIMessageChunk[]) =>
  new ReadableStream<UIMessageChunk>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });

type SendOptions = { body?: { action?: unknown } };
const sends: SendOptions[] = [];
/** What a send's reply stream carries (a begin's, here). */
let sendChunks: UIMessageChunk[] = OPENING;
/** Held open, when set, after the chunks before it: the reply is still running. */
let sendGate: { after: number; until: Promise<void> } | null = null;
/** What the running opening's stream carries, read from its start. */
let openingChunks: UIMessageChunk[] = OPENING;
const sessions = new Map<string, { publicAccessToken: string; isStreaming?: boolean }>();

const fakeTransport = {
  sendMessages: vi.fn(async (options: SendOptions) => {
    sends.push(options);
    const gate = sendGate;
    if (!gate) return streamOf(sendChunks);
    const chunks = sendChunks;
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        for (const [i, chunk] of chunks.entries()) {
          if (i === gate.after) await gate.until;
          controller.enqueue(chunk);
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        controller.close();
      },
    });
  }),
  // As Trigger's transport: nothing to resume without session state marked as
  // mid-reply.
  reconnectToStream: vi.fn(async ({ chatId }: { chatId: string }) =>
    sessions.get(chatId)?.isStreaming ? streamOf(openingChunks) : null
  ),
  setSession: vi.fn((chatId: string, state: { publicAccessToken: string }) => {
    sessions.set(chatId, state);
  }),
  getSession: (chatId: string) => sessions.get(chatId),
  sessionStatus: () => 'open',
};

vi.mock('@trigger.dev/sdk/chat/react', async () => {
  const actual = await vi.importActual<typeof import('@trigger.dev/sdk/chat/react')>(
    '@trigger.dev/sdk/chat/react'
  );
  return { ...actual, useTriggerChatTransport: () => fakeTransport };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const { default: QuizChat } = await import('../QuizChat');

const ATTEMPT = { id: 'attempt-join', completed_at: null, evaluation_json: null };
const QUIZ = { id: 'quiz-1', question_count: 8 };

/** The session route's answer; other api calls (time on page) just succeed. */
let sessionAnswer: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: { publicAccessToken: 'pat-join' },
};
/** Held until it resolves: the session route's answer waits for it. */
let sessionGate: Promise<void> = Promise.resolve();
const sessionRequests = () =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([url]) => url === '/api/quiz-chat/session'
  ).length;

let container: HTMLDivElement;
let root: Root;

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

type Activity = { lastAt: string | null; readAt: string } | null;

const view = (transcript: QuizUIMessage[], chatStarted: boolean, chatActivity: Activity) => (
  <StrictMode>
    <QuizChat
      quiz={QUIZ}
      attempt={ATTEMPT}
      transcript={transcript}
      viewerOwnsAttempt
      chatStarted={chatStarted}
      chatActivity={chatActivity}
    />
  </StrictMode>
);

const render = async (
  transcript: QuizUIMessage[],
  chatStarted: boolean,
  chatActivity: Activity = null
) => {
  await act(async () => {
    root.render(view(transcript, chatStarted, chatActivity));
  });
};

const begins = () => sends.filter(s => (s.body?.action as { type?: string })?.type === 'begin');
const query = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sends.length = 0;
  sessions.clear();
  sendChunks = OPENING;
  sendGate = null;
  openingChunks = OPENING;
  sessionAnswer = { status: 200, body: { publicAccessToken: 'pat-join' } };
  sessionGate = Promise.resolve();
  revalidateMock.mockReset();
  fakeTransport.reconnectToStream.mockClear();
  fakeTransport.setSession.mockClear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/quiz-chat/session') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      await sessionGate;
      return new Response(JSON.stringify(sessionAnswer.body), { status: sessionAnswer.status });
    })
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('QuizChat in a second tab during the opening', () => {
  it('joins the running opening reply instead of sending begin again', async () => {
    await render([], true);
    await settle(120);

    expect(begins()).toHaveLength(0);
    // The session route's token, and a session state that reads the reply
    // stream from its start.
    expect(fakeTransport.setSession).toHaveBeenCalledWith('attempt-join', {
      publicAccessToken: 'pat-join',
      isStreaming: true,
    });
    expect(fakeTransport.reconnectToStream).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(WELCOME);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-error')).toBeNull();
    expect(query('quiz-chat')?.getAttribute('data-quiz-status')).toBe('ready');
  });

  it('shows the activity line while it joins', async () => {
    // The session route has not answered yet.
    let answer: () => void = () => {};
    sessionGate = new Promise<void>(resolve => {
      answer = resolve;
    });
    await render([], true);
    await settle(20);

    expect(begins()).toHaveLength(0);
    expect(query('quiz-typing')).not.toBeNull();
    expect(query('quiz-chat')?.getAttribute('data-quiz-status')).toBe('streaming');

    answer();
    await settle(120);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-typing')).toBeNull();
  });

  it('takes the saved transcript when the opening has already finished', async () => {
    // A reply has finished: the route answers with its cursor. There is
    // nothing left to stream; the saved transcript has the opening.
    sessionAnswer = { status: 200, body: { publicAccessToken: 'pat-join', resumeCursor: '42' } };
    await render([], true);
    await settle(60);

    expect(begins()).toHaveLength(0);
    expect(fakeTransport.setSession).not.toHaveBeenCalled();
    expect(revalidateMock).toHaveBeenCalled();
    expect(query('quiz-typing')).not.toBeNull();

    // The drawer's refresh brings the saved opening.
    await render(SAVED, true);
    await settle(20);

    expect(container.textContent).toContain(WELCOME);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')).toBeNull();
    expect(begins()).toHaveLength(0);
  });

  it('waits for the saved transcript when the reply stream has nothing yet', async () => {
    openingChunks = [];
    await render([], true);
    await settle(60);

    expect(begins()).toHaveLength(0);
    expect(revalidateMock).toHaveBeenCalled();
    expect(query('quiz-typing')).not.toBeNull();

    await render(SAVED, true);
    await settle(20);
    expect(container.textContent).toContain(QUESTION);
    expect(begins()).toHaveLength(0);
  });

  it("shows the session route's refusal, and its retry joins again rather than beginning", async () => {
    sessionAnswer = {
      status: 403,
      body: {
        error: 'CLASSROOM_LOCKED',
        message: 'This class is in read-only mode. The owner has locked it.',
      },
    };
    await render([], true);
    await settle(60);

    expect(query('quiz-error')?.textContent).toContain('read-only mode');
    const retry = query('quiz-error')?.querySelector('button') as HTMLButtonElement;
    expect(retry.textContent).toBe('Start again');

    sessionAnswer = { status: 200, body: { publicAccessToken: 'pat-join' } };
    await act(async () => retry.click());
    await settle(120);

    expect(begins()).toHaveLength(0);
    expect(sessionRequests()).toBe(2);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-error')).toBeNull();
  });

  it('offers begin again only once nothing has been saved for the whole wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    sessionAnswer = { status: 200, body: { publicAccessToken: 'pat-join', resumeCursor: '42' } };
    await render([], true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(query('quiz-typing')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    // Still waiting, refreshing all along.
    expect(query('quiz-typing')).not.toBeNull();
    expect(revalidateMock.mock.calls.length).toBeGreaterThan(100);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 + 10);
    });
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')?.textContent).toContain("The quiz couldn't start.");

    const retry = query('quiz-error')?.querySelector('button') as HTMLButtonElement;
    await act(async () => retry.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(begins()).toHaveLength(1);
  });
});

describe('QuizChat when begin is refused because the quiz has already started', () => {
  it('waits for the saved transcript instead of offering a begin that would be refused', async () => {
    sendChunks = [{ type: 'error', errorText: 'This quiz has already started.' }];
    await render([], false);
    await settle(60);

    expect(begins()).toHaveLength(1);
    // No "Start again" loop: the chat waits for the opening another tab began.
    expect(query('quiz-error')).toBeNull();
    expect(query('quiz-typing')).not.toBeNull();
    expect(revalidateMock).toHaveBeenCalled();

    await render(SAVED, false);
    await settle(20);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-error')).toBeNull();
    expect(begins()).toHaveLength(1);
  });
});

describe('QuizChat on an attempt with no opening yet', () => {
  it('sends begin once and never joins', async () => {
    await render([], false);
    await settle(120);

    expect(begins()).toHaveLength(1);
    expect(fakeTransport.setSession).not.toHaveBeenCalled();
    expect(fakeTransport.reconnectToStream).not.toHaveBeenCalled();
    expect(container.textContent).toContain(QUESTION);
  });
});

describe('QuizChat refreshed while its own opening runs', () => {
  it('keeps reading the begin it sent, and never joins its own opening', async () => {
    let release: () => void = () => {};
    sendGate = { after: 4, until: new Promise<void>(resolve => (release = resolve)) };
    await render([], false);
    await settle(40);
    expect(begins()).toHaveLength(1);
    expect(container.textContent).toContain(WELCOME);

    // The drawer refreshes mid-opening (another fetcher, say): the opening's
    // hidden row is stored by now, so the loader says the chat has started.
    await render([], true);
    await settle(40);
    release();
    await settle(80);

    expect(fakeTransport.setSession).not.toHaveBeenCalled();
    expect(fakeTransport.reconnectToStream).not.toHaveBeenCalled();
    expect(sessionRequests()).toBe(0);
    expect(begins()).toHaveLength(1);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')).toBeNull();
    expect(query('quiz-chat')?.getAttribute('data-quiz-status')).toBe('ready');
  });
});

describe('QuizChat opened on an opening admitted longer ago than a turn can run', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 30, 12, 0, seconds)).toISOString();

  it('offers Start again at once, and its click sends begin', async () => {
    // Admitted 5 minutes before the loader read the attempt; nothing saved.
    await render([], true, { lastAt: at(0), readAt: at(300) });
    await settle(40);

    expect(fakeTransport.reconnectToStream).not.toHaveBeenCalled();
    expect(sessionRequests()).toBe(0);
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')?.textContent).toContain("The quiz couldn't start.");
    expect(begins()).toHaveLength(0);

    const retry = query('quiz-error')?.querySelector('button') as HTMLButtonElement;
    expect(retry.textContent).toBe('Start again');
    await act(async () => retry.click());
    await settle(120);
    expect(begins()).toHaveLength(1);
    expect(container.textContent).toContain(QUESTION);
  });

  it('sends begin again, never a join, when its own Start again fails', async () => {
    await render([], true, { lastAt: at(0), readAt: at(300) });
    await settle(40);

    sendChunks = [
      {
        type: 'error',
        errorText: "That reply couldn't be finished. Please send your message again.",
      },
    ];
    await act(async () =>
      (query('quiz-error')?.querySelector('button') as HTMLButtonElement).click()
    );
    await settle(60);
    expect(begins()).toHaveLength(1);
    const retry = query('quiz-error')?.querySelector('button') as HTMLButtonElement;
    expect(retry.textContent).toBe('Start again');

    sendChunks = OPENING;
    await act(async () => retry.click());
    await settle(120);
    expect(begins()).toHaveLength(2);
    expect(fakeTransport.reconnectToStream).not.toHaveBeenCalled();
    expect(container.textContent).toContain(QUESTION);
  });

  it("joins an opening still within a turn's time, by the server's clock alone", async () => {
    // A minute old by the server's clock, though this browser's clock reads
    // years later.
    await render([], true, { lastAt: at(0), readAt: at(60) });
    await settle(120);

    expect(begins()).toHaveLength(0);
    expect(fakeTransport.reconnectToStream).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(QUESTION);
    expect(query('quiz-error')).toBeNull();
  });

  it('joins as before when the loader has no activity time', async () => {
    await render([], true, { lastAt: null, readAt: at(300) });
    await settle(120);
    expect(fakeTransport.reconnectToStream).toHaveBeenCalledTimes(1);
    expect(begins()).toHaveLength(0);
  });
});

describe('QuizChat when a button click is refused before it is admitted', () => {
  const OFFER: QuizUIMessage[] = [
    ...SAVED,
    {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'Because it lines things up.' }],
    } as QuizUIMessage,
    {
      id: 'feedback-reply',
      role: 'assistant',
      parts: [
        {
          type: 'tool-offer_next_step',
          toolCallId: 'o1',
          state: 'output-available',
          input: { feedback: 'Not quite.', actions: ['try_again', 'next'] },
          output: {
            actions: ['try_again', 'next'],
            lead_in: 'Would you like to try again or move on?',
          },
        },
      ],
    } as unknown as QuizUIMessage,
  ];
  const nextButton = () => query('quiz-next') as HTMLButtonElement;
  const userBubbles = () => container.querySelectorAll('[data-message-role="user"]').length;

  it('gives the buttons back, so the click can be made again', async () => {
    // Too soon after the last message: the stream opens a reply, then refuses.
    sendChunks = [
      { type: 'start', messageId: 'refused-reply' },
      { type: 'error', errorText: 'One message at a time, please. Send it again in a moment.' },
    ];
    await render(OFFER, true);
    await settle(20);
    expect(userBubbles()).toBe(1);

    await act(async () => nextButton().click());
    await settle(60);

    expect(sends).toHaveLength(1);
    expect(query('quiz-error')?.textContent).toContain('One message at a time, please.');
    // The click left the chat, and its set is live again.
    expect(userBubbles()).toBe(1);
    expect(nextButton().disabled).toBe(false);
    expect((query('quiz-try-again') as HTMLButtonElement).disabled).toBe(false);

    // Clicked again, it goes through.
    sendChunks = [
      { type: 'start', messageId: 'next-reply' },
      { type: 'text-start', id: 't9' },
      { type: 'text-delta', id: 't9', delta: 'Question two: why grid?' },
      { type: 'text-end', id: 't9' },
      { type: 'finish' },
    ];
    await act(async () => nextButton().click());
    await settle(60);
    expect(sends).toHaveLength(2);
    expect(query('quiz-error')).toBeNull();
    expect(userBubbles()).toBe(2);
    expect(container.textContent).toContain('Question two: why grid?');
  });
});
