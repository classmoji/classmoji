// @vitest-environment jsdom
/**
 * A reply that never comes. A run can end without answering the message the
 * student just sent (between turns, at its idle limit, in a crash); the
 * message waits on the session, and the next message wakes a run that answers
 * both. The chat gives up a reply that sends nothing for a while
 * (`withReplyDeadline`), without stopping the run, so the student can send
 * that next message, and a reload does not read the dead reply again. The
 * woken run's two replies arrive on one stream, and each shows once, in a
 * message of its own (`withoutFoldedReplies`).
 *
 * The component cases run the real useChat under StrictMode over a fake
 * Trigger transport.
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
/** What the editor sends when its button is clicked. */
let typed = 'Flexbox lays the items out in a row.';
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({
    onSubmit,
    sendButtonTestId,
  }: {
    onSubmit: (t: string) => void;
    sendButtonTestId?: string;
  }) => (
    <button data-testid={sendButtonTestId} onClick={() => onSubmit(typed)}>
      Send
    </button>
  ),
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

/** A stream the test writes to, which records being cancelled. */
const controlled = () => {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const handle = {
    cancelled: false,
    stream: new ReadableStream<UIMessageChunk>({
      start(c) {
        controller = c;
      },
      cancel() {
        handle.cancelled = true;
      },
    }),
    push: (...chunks: UIMessageChunk[]) => chunks.forEach(chunk => controller.enqueue(chunk)),
    close: () => controller.close(),
    fail: (error: unknown) => controller.error(error),
  };
  return handle;
};

type SendOptions = {
  chatId: string;
  messages: QuizUIMessage[];
  abortSignal?: AbortSignal;
  body?: { action?: unknown };
};
type Session = { publicAccessToken: string; isStreaming?: boolean; closed?: boolean };
const sends: SendOptions[] = [];
/** The reply stream of each send, in order. */
let sendStreams: ReturnType<typeof controlled>[] = [];
/** The stream a resume reads. */
let resumed: ReturnType<typeof controlled> | null = null;
const sessions = new Map<string, Session>();
let transportOptions: { onSessionChange?: (chatId: string, s: Session | null) => void } = {};

const fakeTransport = {
  sendMessages: vi.fn(async (options: SendOptions) => {
    sends.push(options);
    const next = sendStreams.shift();
    if (!next) throw new Error('no reply stream set up for this send');
    return next.stream;
  }),
  // As Trigger's transport: nothing to resume without session state marked as mid-reply.
  reconnectToStream: vi.fn(async ({ chatId }: { chatId: string }) =>
    sessions.get(chatId)?.isStreaming && resumed ? resumed.stream : null
  ),
  getSession: (chatId: string) => sessions.get(chatId),
  // As Trigger's transport: the new state is reported through onSessionChange.
  setSession: vi.fn((chatId: string, state: Session) => {
    sessions.set(chatId, state);
    transportOptions.onSessionChange?.(chatId, state);
  }),
  sessionStatus: () => 'open',
};

vi.mock('@trigger.dev/sdk/chat/react', async () => {
  const actual = await vi.importActual<typeof import('@trigger.dev/sdk/chat/react')>(
    '@trigger.dev/sdk/chat/react'
  );
  return {
    ...actual,
    useTriggerChatTransport: (options: typeof transportOptions) => {
      transportOptions = options;
      return fakeTransport;
    },
  };
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

const {
  default: QuizChat,
  REPLY_START_MS,
  REPLY_SILENCE_MS,
  withReplyDeadline,
  withoutFoldedReplies,
  liveButtonsOf,
} = await import('../QuizChat');

const text = (id: string, value: string): UIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];

// ---------------------------------------------------------------------------
// withReplyDeadline
// ---------------------------------------------------------------------------

describe('withReplyDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Reads the stream into `got` until it ends. */
  const drain = (stream: ReadableStream<UIMessageChunk>) => {
    const got: UIMessageChunk[] = [];
    const state = { ended: false, error: undefined as unknown };
    const reader = stream.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got.push(value);
        }
        state.ended = true;
      } catch (error) {
        state.error = error;
      }
    })();
    return { got, state };
  };

  it('gives up a reply that sends nothing, ending the stream and cancelling the source', async () => {
    const source = controlled();
    const onLapse = vi.fn();
    const { state } = drain(withReplyDeadline(source.stream, onLapse));

    await vi.advanceTimersByTimeAsync(REPLY_START_MS - 1);
    expect(onLapse).not.toHaveBeenCalled();
    expect(state.ended).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(onLapse).toHaveBeenCalledTimes(1);
    expect(state.ended).toBe(true);
    expect(state.error).toBeUndefined();
    expect(source.cancelled).toBe(true);
  });

  it('a chunk gives the reply the longer wait from then on', async () => {
    const source = controlled();
    const onLapse = vi.fn();
    const { got, state } = drain(withReplyDeadline(source.stream, onLapse));

    await vi.advanceTimersByTimeAsync(REPLY_START_MS - 1_000);
    source.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([{ type: 'start', messageId: 'r1' }]);

    // Past the first wait: the reply has begun, so it is not given up.
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1);
    expect(onLapse).not.toHaveBeenCalled();
    expect(state.ended).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(onLapse).toHaveBeenCalledTimes(1);
    expect(state.ended).toBe(true);
    expect(source.cancelled).toBe(true);
  });

  it('changes nothing while chunks keep arriving, and passes the stream through', async () => {
    const source = controlled();
    const onLapse = vi.fn();
    const { got, state } = drain(withReplyDeadline(source.stream, onLapse));
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'r1' },
      { type: 'start-step' },
      ...text('t1', 'Close: say which axis.'),
      { type: 'finish-step' },
      { type: 'finish' },
    ];

    await vi.advanceTimersByTimeAsync(REPLY_START_MS - 1);
    for (const chunk of chunks) {
      source.push(chunk);
      await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1);
    }
    source.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(got).toEqual(chunks);
    expect(state.ended).toBe(true);
    expect(source.cancelled).toBe(false);
    // Nothing fires after the stream has ended.
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS * 2);
    expect(onLapse).not.toHaveBeenCalled();
  });

  it("passes the source's error on, and a reader's cancel to the source, without a lapse", async () => {
    const failing = controlled();
    const onLapse = vi.fn();
    const { got, state } = drain(withReplyDeadline(failing.stream, onLapse));
    const error = new Error('stream failed');
    failing.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(0);
    failing.fail(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([{ type: 'start', messageId: 'r1' }]);
    expect(state.error).toBe(error);
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS * 2);
    expect(onLapse).not.toHaveBeenCalled();

    const source = controlled();
    const wrapped = withReplyDeadline(source.stream, onLapse);
    await wrapped.cancel('done');
    expect(source.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(REPLY_START_MS * 2);
    expect(onLapse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withoutFoldedReplies
// ---------------------------------------------------------------------------

const user = (id: string, value: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text: value }] }) as QuizUIMessage;
const assistant = (id: string, parts: unknown[]) =>
  ({ id, role: 'assistant', parts }) as unknown as QuizUIMessage;
const textPart = (value: string) => ({ type: 'text', text: value, state: 'done' });
const offerPart = (callId: string) => ({
  type: 'tool-offer_next_step',
  toolCallId: callId,
  state: 'output-available',
  input: { actions: ['try_again', 'next'], feedback: 'Not quite.' },
  output: { actions: ['try_again', 'next'] },
});

describe('withoutFoldedReplies', () => {
  it('takes a reply folded into the next one back out of it', () => {
    const a = assistant('a', [{ type: 'step-start' }, textPart('Answer to the first.')]);
    const b = assistant('b', [...a.parts, { type: 'step-start' }, textPart('Yes, still here.')]);
    const messages = [user('u1', 'first'), user('u2', 'you there?'), a, b];

    const out = withoutFoldedReplies(messages);
    expect(out[2]).toBe(a);
    expect(out[3].parts).toEqual([{ type: 'step-start' }, textPart('Yes, still here.')]);
    expect(out[3].id).toBe('b');
  });

  it('unfolds a chain of replies, each against the one before it as it came', () => {
    const a = assistant('a', [textPart('One.')]);
    const b = assistant('b', [...a.parts, textPart('Two.')]);
    const c = assistant('c', [...b.parts, textPart('Three.')]);

    const out = withoutFoldedReplies([user('u1', 'x'), a, b, c]);
    expect(out.slice(1).map(m => m.parts)).toEqual([
      [textPart('One.')],
      [textPart('Two.')],
      [textPart('Three.')],
    ]);
  });

  it('leaves a transcript without folded replies as it is', () => {
    const messages = [
      user('u1', 'first'),
      assistant('a', [textPart('Same words.')]),
      assistant('b', [textPart('Other words.'), textPart('Same words.')]),
      user('u2', 'second'),
      assistant('c', [textPart('Same words.')]),
    ];
    expect(withoutFoldedReplies(messages)).toBe(messages);
    // An empty reply holds nothing to take out.
    const empty = [assistant('a', []), assistant('b', [textPart('Hi.')])];
    expect(withoutFoldedReplies(empty)).toBe(empty);
  });

  it("gives the buttons to the later reply's offer, not the earlier one's copy", () => {
    const a = assistant('a', [offerPart('c1')]);
    const b = assistant('b', [...a.parts, textPart('Here.'), offerPart('c2')]);
    const out = withoutFoldedReplies([user('u1', 'x'), user('u2', 'y'), a, b]);
    expect(liveButtonsOf(out)).toEqual({ message: 3, part: 1 });
  });
});

// ---------------------------------------------------------------------------
// The live chat
// ---------------------------------------------------------------------------

const ATTEMPT = { id: 'attempt-quiet', completed_at: null, evaluation_json: null };
const QUIZ = { id: 'quiz-1', question_count: 8 };
const QUESTION = 'Question one: why does the header use flexbox?';
const TRANSCRIPT: QuizUIMessage[] = [assistant('opening', [{ type: 'text', text: QUESTION }])];
const STALLED = 'Flexbox lays the items out in a row.';
const NUDGE = 'you there?';
const FIRST_REPLY = 'Right: the items sit in a row along the main axis.';
const SECOND_REPLY = 'Yes, still here.';

let container: HTMLDivElement;
let root: Root;

/**
 * Under StrictMode (the webapp's client entry) unless `strict` is false: a
 * resume runs from a mount effect, which StrictMode runs twice, and Trigger's
 * transport gives the second run nothing while the first holds the stream.
 * The production build runs it once.
 */
const render = async (transcript: QuizUIMessage[] = TRANSCRIPT, strict = true) => {
  const chat = <QuizChat quiz={QUIZ} attempt={ATTEMPT} transcript={transcript} viewerOwnsAttempt />;
  await act(async () => {
    root.render(strict ? <StrictMode>{chat}</StrictMode> : chat);
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const query = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const status = () => query('quiz-chat')?.getAttribute('data-quiz-status');
const sendText = async (value: string) => {
  typed = value;
  await act(async () => (query('quiz-send') as HTMLButtonElement).click());
};
const occurrences = (needle: string) => (container.textContent ?? '').split(needle).length - 1;
const storedSession = () =>
  JSON.parse(window.sessionStorage.getItem(`classmoji:quiz-chat-session:${ATTEMPT.id}`) ?? 'null');

describe('QuizChat when a reply never comes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sends.length = 0;
    sendStreams = [];
    resumed = null;
    sessions.clear();
    sessions.set(ATTEMPT.id, { publicAccessToken: 'pat' });
    transportOptions = {};
    fakeTransport.sendMessages.mockClear();
    fakeTransport.reconnectToStream.mockClear();
    fakeTransport.setSession.mockClear();
    window.sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('takes a message again once a reply sends nothing, without stopping the run', async () => {
    const stalled = controlled();
    sendStreams = [stalled];
    await render();

    await sendText(STALLED);
    await advance(10);
    expect(status()).toBe('streaming');
    expect(query('quiz-typing')).not.toBeNull();
    // Nothing goes out while the reply is awaited.
    await sendText(NUDGE);
    expect(sends).toHaveLength(1);

    await advance(REPLY_START_MS - 100);
    expect(status()).toBe('streaming');

    await advance(100);
    expect(status()).toBe('ready');
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')).toBeNull();
    // This tab stopped reading; the request was not aborted, so no stop was sent.
    expect(stalled.cancelled).toBe(true);
    expect(sends[0].abortSignal?.aborted ?? false).toBe(false);
    // The session state no longer says a reply is running, here and in storage.
    expect(fakeTransport.setSession).toHaveBeenCalledWith(
      ATTEMPT.id,
      expect.objectContaining({ isStreaming: false, activeInputSeq: undefined })
    );
    expect(storedSession()).toMatchObject({ publicAccessToken: 'pat', isStreaming: false });
    // The student's message stays, once.
    expect(occurrences(STALLED)).toBe(1);
  });

  it('the next message wakes a run whose two replies each show once, in order', async () => {
    const stalled = controlled();
    const woken = controlled();
    sendStreams = [stalled, woken];
    await render();

    await sendText(STALLED);
    await advance(REPLY_START_MS + 10);
    expect(status()).toBe('ready');

    await sendText(NUDGE);
    await advance(10);
    expect(sends).toHaveLength(2);
    // The send carries the new message (Trigger's transport sends only the last).
    expect(sends[1].messages.at(-1)?.parts).toEqual([{ type: 'text', text: NUDGE }]);

    // The run answers the waiting message first, then the new one, on one stream.
    woken.push(
      { type: 'start', messageId: 'reply-a' },
      { type: 'start-step' },
      ...text('ta', FIRST_REPLY),
      { type: 'finish-step' },
      { type: 'finish' },
      { type: 'start', messageId: 'reply-b' }
    );
    await advance(10);
    // The second reply has begun but shows nothing of its own yet: no empty bubble.
    expect(container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(2);
    expect(occurrences(FIRST_REPLY)).toBe(1);

    woken.push(
      { type: 'start-step' },
      ...text('tb', SECOND_REPLY),
      { type: 'finish-step' },
      { type: 'finish' }
    );
    woken.close();
    await advance(10);

    expect(status()).toBe('ready');
    expect(occurrences(STALLED)).toBe(1);
    expect(occurrences(NUDGE)).toBe(1);
    expect(occurrences(FIRST_REPLY)).toBe(1);
    expect(occurrences(SECOND_REPLY)).toBe(1);
    // The opening's message, then one for each reply.
    expect(container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(3);
    const all = container.textContent ?? '';
    expect(all.indexOf(STALLED)).toBeLessThan(all.indexOf(NUDGE));
    expect(all.indexOf(NUDGE)).toBeLessThan(all.indexOf(FIRST_REPLY));
    expect(all.indexOf(FIRST_REPLY)).toBeLessThan(all.indexOf(SECOND_REPLY));
  });

  it('keeps waiting while a slow reply keeps sending', async () => {
    const slow = controlled();
    sendStreams = [slow];
    await render();

    await sendText(STALLED);
    await advance(REPLY_START_MS - 1_000);
    slow.push({ type: 'start', messageId: 'reply-a' }, { type: 'start-step' });
    // A long silence while the model thinks, under the turn's deadline.
    await advance(REPLY_SILENCE_MS - 1_000);
    expect(status()).toBe('streaming');
    slow.push(...text('ta', FIRST_REPLY));
    await advance(REPLY_SILENCE_MS - 1_000);
    expect(status()).toBe('streaming');
    await sendText(NUDGE);
    expect(sends).toHaveLength(1);

    slow.push({ type: 'finish-step' }, { type: 'finish' });
    slow.close();
    await advance(10);
    expect(status()).toBe('ready');
    expect(slow.cancelled).toBe(false);
    expect(fakeTransport.setSession).not.toHaveBeenCalled();
    expect(occurrences(FIRST_REPLY)).toBe(1);
  });

  it('gives up a reply that went quiet after it began, past the turn deadline', async () => {
    const dying = controlled();
    sendStreams = [dying];
    await render();

    await sendText(STALLED);
    await advance(1_000);
    dying.push({ type: 'start', messageId: 'reply-a' }, ...text('ta', 'Partly'));
    await advance(REPLY_SILENCE_MS - 10);
    expect(status()).toBe('streaming');
    await advance(10);
    expect(status()).toBe('ready');
    expect(dying.cancelled).toBe(true);
    expect(occurrences('Partly')).toBe(1);
  });

  it('a reload gives up re-reading a reply that sends nothing', async () => {
    window.sessionStorage.setItem(
      `classmoji:quiz-chat-session:${ATTEMPT.id}`,
      JSON.stringify({ publicAccessToken: 'pat', isStreaming: true })
    );
    sessions.set(ATTEMPT.id, { publicAccessToken: 'pat', isStreaming: true });
    resumed = controlled();
    const answered = controlled();
    sendStreams = [answered];
    await render(TRANSCRIPT, false);

    await advance(10);
    expect(fakeTransport.reconnectToStream).toHaveBeenCalledTimes(1);
    expect(status()).toBe('streaming');
    expect(query('quiz-typing')).not.toBeNull();

    await advance(REPLY_START_MS);
    expect(status()).toBe('ready');
    expect(resumed.cancelled).toBe(true);
    expect(storedSession()).toMatchObject({ isStreaming: false });
    // Not the opening's (the chat has a reply): no wait for a saved transcript.
    expect(query('quiz-typing')).toBeNull();

    await sendText(NUDGE);
    await advance(10);
    expect(sends).toHaveLength(1);
  });

  it("leaves the begin action's stream to the opening's own wait", async () => {
    const opening = controlled();
    sendStreams = [opening];
    await render([]);
    await advance(10);
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.action).toEqual({ type: 'begin' });

    await advance(REPLY_START_MS * 2);
    expect(opening.cancelled).toBe(false);
    expect(status()).toBe('streaming');
  });

  it("waits for the saved opening when a reload's re-read of it sends nothing", async () => {
    window.sessionStorage.setItem(
      `classmoji:quiz-chat-session:${ATTEMPT.id}`,
      JSON.stringify({ publicAccessToken: 'pat', isStreaming: true })
    );
    sessions.set(ATTEMPT.id, { publicAccessToken: 'pat', isStreaming: true });
    resumed = controlled();
    await render([], false);
    await advance(10);
    expect(sends).toHaveLength(0);
    expect(query('quiz-typing')).not.toBeNull();

    await advance(REPLY_START_MS);
    expect(resumed.cancelled).toBe(true);
    expect(storedSession()).toMatchObject({ isStreaming: false });
    // No reply in the chat yet: the opening's saved transcript is waited for
    // (the chat keeps its activity line) rather than a message taken.
    expect(query('quiz-typing')).not.toBeNull();
    expect(query('quiz-error')).toBeNull();
    expect(sends).toHaveLength(0);
  });
});
