// @vitest-environment jsdom
/**
 * A reply that never comes. A run can end without answering the message the
 * student just sent (between turns, at its idle limit, in a crash); the
 * message waits on the session, and the next message wakes a run that answers
 * both. A reply that sends nothing for a while goes quiet (`watchReply`): the
 * chat takes a message again while the reply is still read, so a late reply
 * (a run that was only queued) still shows as it comes, and a reload does not
 * wait on it again. A message sent then releases the quiet reply, without
 * stopping the run, and goes once useChat has let it go. The woken run's two
 * replies arrive on one stream, and each shows once, in a message of its own
 * (`withoutFoldedReplies`).
 *
 * The component cases run the real useChat over a fake Trigger transport.
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { BUTTON_TEXT, type QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
/** What the editor sends when its button is clicked. */
let typed = 'Flexbox lays the items out in a row.';
/** The submit handler of the editor as last rendered. */
let editorSubmit: ((t: string) => void) | null = null;
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({
    onSubmit,
    sendButtonTestId,
  }: {
    onSubmit: (t: string) => void;
    sendButtonTestId?: string;
  }) => {
    editorSubmit = onSubmit;
    return (
      <button data-testid={sendButtonTestId} onClick={() => onSubmit(typed)}>
        Send
      </button>
    );
  },
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
type Session = {
  publicAccessToken: string;
  isStreaming?: boolean;
  activeInputSeq?: number;
  lastEventId?: string;
  closed?: boolean;
};
const sends: SendOptions[] = [];
/** The reply stream of each send, in order. */
let sendStreams: ReturnType<typeof controlled>[] = [];
/** The stream a resume reads. */
let resumed: ReturnType<typeof controlled> | null = null;
const sessions = new Map<string, Session>();
/** The reply stream the transport reads now. */
let active: ReturnType<typeof controlled> | null = null;
let transportOptions: { onSessionChange?: (chatId: string, s: Session | null) => void } = {};
/** As Trigger's transport: a change to the session state is reported. */
const changeSession = (chatId: string, state: Session) => {
  sessions.set(chatId, state);
  transportOptions.onSessionChange?.(chatId, state);
};

const fakeTransport = {
  sendMessages: vi.fn(async (options: SendOptions) => {
    sends.push(options);
    const next = sendStreams.shift();
    if (!next) throw new Error('no reply stream set up for this send');
    // As Trigger's transport (chat.js:342-347): a send ends the reply stream
    // it supersedes (cleanly, without a stop).
    try {
      active?.close();
    } catch {
      // Already cancelled by this tab.
    }
    active = next;
    // As Trigger's transport (chat.js:347-351): the send marks a reply as running.
    changeSession(options.chatId, {
      ...(sessions.get(options.chatId) ?? { publicAccessToken: 'pat' }),
      isStreaming: true,
      activeInputSeq: sends.length,
      lastEventId: `before-${sends.length}`,
    });
    return next.stream;
  }),
  // As Trigger's transport: nothing to resume without session state marked as mid-reply.
  reconnectToStream: vi.fn(async ({ chatId }: { chatId: string }) => {
    if (!sessions.get(chatId)?.isStreaming || !resumed) return null;
    active = resumed;
    return resumed.stream;
  }),
  getSession: (chatId: string) => sessions.get(chatId),
  setSession: vi.fn((chatId: string, state: Session) => changeSession(chatId, state)),
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
  watchReply,
  withoutFoldedReplies,
  liveButtonsOf,
} = await import('../QuizChat');

const text = (id: string, value: string): UIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];

/** The tab leaves view, then comes back. */
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

// ---------------------------------------------------------------------------
// watchReply
// ---------------------------------------------------------------------------

describe('watchReply', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
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

  it('goes quiet when a reply sends nothing, and keeps reading it', async () => {
    const source = controlled();
    const changes: boolean[] = [];
    const reply = watchReply(source.stream, quiet => changes.push(quiet));
    const { got, state } = drain(reply.stream);

    await vi.advanceTimersByTimeAsync(REPLY_START_MS - 1);
    expect(reply.quiet).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);
    expect(changes).toEqual([true]);
    expect(state.ended).toBe(false);
    expect(source.cancelled).toBe(false);

    // A late reply ends the quiet, and comes through.
    source.push({ type: 'start', messageId: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(reply.quiet).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(got).toEqual([{ type: 'start', messageId: 'late' }]);
  });

  it('a chunk gives the reply the longer wait from then on', async () => {
    const source = controlled();
    const reply = watchReply(source.stream, () => {});
    drain(reply.stream);

    await vi.advanceTimersByTimeAsync(REPLY_START_MS - 1_000);
    source.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);
  });

  it('changes nothing while chunks keep arriving, and passes the stream through', async () => {
    const source = controlled();
    const onQuietChange = vi.fn();
    const reply = watchReply(source.stream, onQuietChange);
    const { got, state } = drain(reply.stream);
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
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS * 2);
    expect(onQuietChange).not.toHaveBeenCalled();
  });

  it('release stops reading here: the source is cancelled and the stream ends', async () => {
    const source = controlled();
    const changes: boolean[] = [];
    const reply = watchReply(source.stream, quiet => changes.push(quiet));
    const { state } = drain(reply.stream);
    await vi.advanceTimersByTimeAsync(REPLY_START_MS);
    expect(reply.quiet).toBe(true);

    reply.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.cancelled).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.error).toBeUndefined();
    expect(reply.quiet).toBe(false);
    expect(changes).toEqual([true, false]);
    // Nothing after the end.
    reply.release();
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS * 2);
    expect(changes).toEqual([true, false]);
  });

  it('waits afresh when the tab comes back into view', async () => {
    const source = controlled();
    const reply = watchReply(source.stream, () => {});
    drain(reply.stream);
    source.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(0);

    // Hidden (a closed lid) for most of the wait, then back.
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1_000);
    setVisibility('visible');
    // The original wait would end here; the fresh one has not.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reply.quiet).toBe(false);
    // The transport reconnects and the reply goes on.
    source.push(...text('t1', 'More.'));
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);
  });

  it("passes the source's error on, and a reader's cancel to the source", async () => {
    const failing = controlled();
    const onQuietChange = vi.fn();
    const failed = watchReply(failing.stream, onQuietChange);
    const { got, state } = drain(failed.stream);
    const error = new Error('stream failed');
    failing.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(0);
    failing.fail(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([{ type: 'start', messageId: 'r1' }]);
    expect(state.error).toBe(error);
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS * 2);
    expect(onQuietChange).not.toHaveBeenCalled();

    const source = controlled();
    const reply = watchReply(source.stream, onQuietChange);
    await reply.stream.cancel('done');
    expect(source.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(REPLY_START_MS * 2);
    expect(onQuietChange).not.toHaveBeenCalled();
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
/** QuizChat's wait for a saved opening (SAVED_OPENING_WAIT_MS). */
const SAVED_OPENING_WAIT = 5 * 60_000;

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
const assistantMessages = () => container.querySelectorAll('[data-message-role="assistant"]');
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
    active = null;
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

  /** Sends the stalled message and lets its reply go quiet. */
  const stall = async () => {
    await sendText(STALLED);
    await advance(10);
    expect(status()).toBe('streaming');
    await advance(REPLY_START_MS);
    expect(status()).toBe('ready');
  };

  it('takes a message again once a reply sends nothing, still reading it', async () => {
    const stalled = controlled();
    sendStreams = [stalled];
    await render();

    await sendText(STALLED);
    await advance(10);
    expect(status()).toBe('streaming');
    expect(query('quiz-typing')).not.toBeNull();
    expect(storedSession()).toMatchObject({ isStreaming: true });
    // Nothing goes out while the reply is awaited.
    await sendText(NUDGE);
    expect(sends).toHaveLength(1);

    await advance(REPLY_START_MS - 100);
    expect(status()).toBe('streaming');

    await advance(100);
    expect(status()).toBe('ready');
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')).toBeNull();
    // Still reading, and the request was not aborted (no stop was sent).
    expect(stalled.cancelled).toBe(false);
    expect(sends[0].abortSignal?.aborted ?? false).toBe(false);
    // The stored state no longer says a reply is running; the transport's does.
    expect(storedSession()).toMatchObject({ publicAccessToken: 'pat', isStreaming: false });
    expect(sessions.get(ATTEMPT.id)?.isStreaming).toBe(true);
    // A change the transport reports meanwhile (a token refresh) keeps it so.
    transportOptions.onSessionChange?.(ATTEMPT.id, {
      publicAccessToken: 'pat-2',
      isStreaming: true,
    });
    expect(storedSession()).toMatchObject({ publicAccessToken: 'pat-2', isStreaming: false });
    // The student's message stays, once.
    expect(occurrences(STALLED)).toBe(1);
  });

  it('shows a late reply as it comes, then takes messages', async () => {
    const late = controlled();
    sendStreams = [late];
    await render();
    await stall();

    late.push(
      { type: 'start', messageId: 'reply-a' },
      { type: 'start-step' },
      ...text('ta', FIRST_REPLY)
    );
    await advance(10);
    // Read like any reply: the chat waits for it again.
    expect(status()).toBe('streaming');
    expect(storedSession()).toMatchObject({ isStreaming: true });
    await sendText(NUDGE);
    expect(sends).toHaveLength(1);

    late.push({ type: 'finish-step' }, { type: 'finish' });
    late.close();
    await advance(10);
    expect(status()).toBe('ready');
    expect(late.cancelled).toBe(false);
    expect(occurrences(FIRST_REPLY)).toBe(1);
    expect(assistantMessages()).toHaveLength(2);

    sendStreams = [controlled()];
    await sendText(NUDGE);
    await advance(10);
    expect(sends).toHaveLength(2);
  });

  it('a message sent while quiet releases the reply, and its run answers both once each', async () => {
    const stalled = controlled();
    const woken = controlled();
    sendStreams = [stalled, woken];
    await render();
    await stall();

    await sendText(NUDGE);
    // This tab stopped reading the quiet reply, without stopping the run.
    expect(stalled.cancelled).toBe(true);
    expect(sends[0].abortSignal?.aborted ?? false).toBe(false);
    await advance(10);
    // Sent once useChat let the quiet reply go, and awaited as any reply.
    expect(sends).toHaveLength(2);
    expect(sends[1].messages.at(-1)?.parts).toEqual([{ type: 'text', text: NUDGE }]);
    expect(status()).toBe('streaming');
    expect(query('quiz-typing')).not.toBeNull();
    expect(storedSession()).toMatchObject({ isStreaming: true });

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
    expect(assistantMessages()).toHaveLength(2);
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
    // The opening's message, then one for each reply, each after the message
    // it answers, as the saved transcript has them.
    expect(assistantMessages()).toHaveLength(3);
    const all = container.textContent ?? '';
    expect(all.indexOf(STALLED)).toBeLessThan(all.indexOf(FIRST_REPLY));
    expect(all.indexOf(FIRST_REPLY)).toBeLessThan(all.indexOf(NUDGE));
    expect(all.indexOf(NUDGE)).toBeLessThan(all.indexOf(SECOND_REPLY));
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

  it('goes quiet when a reply that began is silent past the turn deadline', async () => {
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
    expect(dying.cancelled).toBe(false);
    expect(occurrences('Partly')).toBe(1);
  });

  it('a reload stops waiting on a reply that sends nothing', async () => {
    window.sessionStorage.setItem(
      `classmoji:quiz-chat-session:${ATTEMPT.id}`,
      JSON.stringify({ publicAccessToken: 'pat', isStreaming: true })
    );
    sessions.set(ATTEMPT.id, { publicAccessToken: 'pat', isStreaming: true });
    resumed = controlled();
    sendStreams = [controlled()];
    await render(TRANSCRIPT, false);

    await advance(10);
    expect(fakeTransport.reconnectToStream).toHaveBeenCalledTimes(1);
    expect(status()).toBe('streaming');
    expect(query('quiz-typing')).not.toBeNull();

    await advance(REPLY_START_MS);
    expect(status()).toBe('ready');
    expect(storedSession()).toMatchObject({ isStreaming: false });
    // Not the opening's (the chat has a reply): no wait for a saved transcript.
    expect(query('quiz-typing')).toBeNull();

    await sendText(NUDGE);
    expect(resumed.cancelled).toBe(true);
    await advance(10);
    expect(sends).toHaveLength(1);
  });

  it('a begin that sends nothing waits for the saved opening, then offers Start again', async () => {
    const opening = controlled();
    sendStreams = [opening, controlled()];
    await render([]);
    await advance(10);
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.action).toEqual({ type: 'begin' });

    await advance(REPLY_START_MS);
    // Released without a stop, and no reply is marked as running.
    expect(opening.cancelled).toBe(true);
    expect(sends[0].abortSignal?.aborted ?? false).toBe(false);
    expect(storedSession()).toMatchObject({ isStreaming: false });
    // Waiting for the saved opening, as a join does: no message is taken yet.
    expect(query('quiz-typing')).not.toBeNull();
    expect(query('quiz-error')).toBeNull();

    await advance(SAVED_OPENING_WAIT);
    expect(query('quiz-typing')).toBeNull();
    expect(query('quiz-error')?.textContent).toContain("The quiz couldn't start.");
    const retry = query('quiz-error')?.querySelector('button') as HTMLButtonElement;
    expect(retry.textContent).toBe('Start again');
    await act(async () => retry.click());
    await advance(10);
    expect(sends).toHaveLength(2);
    expect(sends[1].body?.action).toEqual({ type: 'begin' });
  });

  it('a reply that comes back after its quiet is stored as running from where it began', async () => {
    const late = controlled();
    sendStreams = [late];
    await render();
    await stall();
    expect(storedSession()).toMatchObject({ isStreaming: false, lastEventId: 'before-1' });

    // The transport reads on past the cursor it had; a token refresh meanwhile
    // reports its state as it is, inside the reply.
    sessions.set(ATTEMPT.id, { ...sessions.get(ATTEMPT.id)!, lastEventId: 'inside-1' });
    transportOptions.onSessionChange?.(ATTEMPT.id, {
      ...sessions.get(ATTEMPT.id)!,
      publicAccessToken: 'pat-2',
    });
    expect(storedSession()).toMatchObject({
      publicAccessToken: 'pat-2',
      isStreaming: false,
      lastEventId: 'before-1',
    });

    late.push({ type: 'start', messageId: 'reply-a' }, ...text('ta', FIRST_REPLY));
    await advance(10);
    // Running again, at the cursor before the reply: a reload reads it from
    // its start, never from inside it.
    expect(storedSession()).toMatchObject({ isStreaming: true, lastEventId: 'before-1' });
  });

  it('a released reply is not stored as running again', async () => {
    const writes: Session[] = [];
    const setItem = window.sessionStorage.setItem.bind(window.sessionStorage);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      writes.push(JSON.parse(value) as Session);
      setItem(key, value);
    });
    sendStreams = [controlled(), controlled()];
    await render();
    await stall();
    const quietAt = writes.length;

    await sendText(NUDGE);
    await advance(10);
    expect(sends).toHaveLength(2);
    // After the quiet, only the new message's send says a reply is running.
    const running = writes.slice(quietAt).filter(w => w.isStreaming);
    expect(running.length).toBeGreaterThan(0);
    expect(running.every(w => w.activeInputSeq === 2)).toBe(true);
    spy.mockRestore();
  });

  it('a message sent as a quiet reply comes back waits for it, then goes', async () => {
    const late = controlled();
    sendStreams = [late, controlled()];
    await render();
    await stall();

    // A chunk lands after the chat last rendered, before the click is handled
    // (by the handler of that render, which still shows the reply quiet).
    const submitAsRendered = editorSubmit!;
    await act(async () => {
      late.push({ type: 'start', messageId: 'reply-a' });
      await vi.advanceTimersByTimeAsync(0);
      submitAsRendered(NUDGE);
    });
    // Not dropped, not sent into the open reply: held, and the reply read on.
    expect(sends).toHaveLength(1);
    expect(late.cancelled).toBe(false);
    expect(status()).toBe('streaming');

    late.push(...text('ta', FIRST_REPLY), { type: 'finish' });
    late.close();
    await advance(10);
    expect(sends).toHaveLength(2);
    expect(sends[1].messages.at(-1)?.parts).toEqual([{ type: 'text', text: NUDGE }]);
    expect(occurrences(FIRST_REPLY)).toBe(1);
    expect(occurrences(NUDGE)).toBe(1);
  });

  it("drops what is left of a reply released part way, up to the next reply's start", async () => {
    const dying = controlled();
    const next = controlled();
    sendStreams = [dying, next];
    await render();

    await sendText(STALLED);
    await advance(1_000);
    dying.push({ type: 'start', messageId: 'reply-a' }, { type: 'text-start', id: 'ta' });
    dying.push({ type: 'text-delta', id: 'ta', delta: 'Partly' });
    await advance(REPLY_SILENCE_MS);
    expect(status()).toBe('ready');

    await sendText(NUDGE);
    await advance(10);
    expect(sends).toHaveLength(2);
    // The new stream reads on from inside the released reply.
    next.push(
      { type: 'text-delta', id: 'ta', delta: ' and the rest.' },
      { type: 'text-end', id: 'ta' },
      { type: 'finish' },
      { type: 'start', messageId: 'reply-b' },
      ...text('tb', SECOND_REPLY),
      { type: 'finish' }
    );
    next.close();
    await advance(10);

    expect(query('quiz-error')).toBeNull();
    expect(status()).toBe('ready');
    expect(occurrences('Partly')).toBe(1);
    expect(occurrences('and the rest.')).toBe(0);
    expect(occurrences(SECOND_REPLY)).toBe(1);
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
    // Released, and no reply is marked as running, here or in storage.
    expect(resumed.cancelled).toBe(true);
    expect(sessions.get(ATTEMPT.id)?.isStreaming).toBe(false);
    expect(storedSession()).toMatchObject({ isStreaming: false });
    // No reply in the chat yet: the opening's saved transcript is waited for
    // (the chat keeps its activity line) rather than a message taken.
    expect(query('quiz-typing')).not.toBeNull();
    expect(query('quiz-error')).toBeNull();
    expect(sends).toHaveLength(0);
  });

  /** The usable buttons, by assistant message: `<message>:<button>`. */
  const usableButtons = (within: HTMLElement) =>
    [...within.querySelectorAll('[data-message-role="assistant"]')].flatMap((message, i) =>
      [
        ...message.querySelectorAll<HTMLButtonElement>(
          '[data-testid="quiz-try-again"], [data-testid="quiz-next"]'
        ),
      ]
        .filter(button => !button.disabled)
        .map(button => `${i}:${button.getAttribute('data-testid')}`)
    );
  /** What a reload shows: the saved transcript, read fresh. */
  const reloadButtons = async (saved: QuizUIMessage[]) => {
    const other = document.createElement('div');
    document.body.appendChild(other);
    const otherRoot = createRoot(other);
    await act(async () => {
      otherRoot.render(
        <QuizChat
          quiz={QUIZ}
          attempt={{ ...ATTEMPT, id: 'attempt-reloaded' }}
          transcript={saved}
          viewerOwnsAttempt
        />
      );
    });
    const usable = usableButtons(other);
    await act(async () => otherRoot.unmount());
    other.remove();
    return usable;
  };
  const OFFERED = assistant('offered', [textPart(QUESTION), offerPart('c0')]);
  const offerChunks = (callId: string): UIMessageChunk[] => [
    {
      type: 'tool-input-available',
      toolCallId: callId,
      toolName: 'offer_next_step',
      input: offerPart(callId).input,
    },
    { type: 'tool-output-available', toolCallId: callId, output: offerPart(callId).output },
  ];
  const HINT = 'Think about which axis justify-content works on.';

  it('a click while a reply is quiet gets the buttons a reload shows, once the run answers both', async () => {
    const woken = controlled();
    sendStreams = [controlled(), woken];
    await render([OFFERED]);
    await stall();

    // The offer's buttons are usable while the reply is quiet.
    expect(usableButtons(container)).toEqual(['0:quiz-try-again', '0:quiz-next']);
    await act(async () => (query('quiz-try-again') as HTMLButtonElement).click());
    await advance(10);
    expect(sends).toHaveLength(2);
    expect(sends[1].messages.at(-1)?.parts).toEqual([
      { type: 'text', text: BUTTON_TEXT.try_again },
    ]);

    // The waiting answer's reply (feedback and a new offer), then the hint.
    woken.push(
      { type: 'start', messageId: 'reply-a' },
      ...text('ta', FIRST_REPLY),
      ...offerChunks('c1'),
      { type: 'finish' },
      { type: 'start', messageId: 'reply-b' },
      ...text('tb', HINT),
      { type: 'finish' }
    );
    woken.close();
    await advance(10);

    const saved = [
      OFFERED,
      user('u1', STALLED),
      assistant('reply-a', [textPart(FIRST_REPLY), offerPart('c1')]),
      user('u2', BUTTON_TEXT.try_again),
      assistant('reply-b', [textPart(HINT)]),
    ];
    const reloaded = await reloadButtons(saved);
    // The hint ends with Next alone; the answered offer is used up.
    expect(reloaded).toEqual(['2:quiz-next']);
    expect(usableButtons(container)).toEqual(reloaded);
  });

  it('a click whose reply never came keeps its buttons given back after a typed message', async () => {
    const woken = controlled();
    sendStreams = [controlled(), woken];
    await render([OFFERED]);

    // The click is the message whose reply goes quiet.
    await act(async () => (query('quiz-try-again') as HTMLButtonElement).click());
    await advance(REPLY_START_MS + 10);
    expect(status()).toBe('ready');
    expect(usableButtons(container)).toEqual([]);

    await sendText(NUDGE);
    await advance(10);
    expect(sends).toHaveLength(2);
    // The click's reply did not get through (a notice), so its set is given
    // back; the typed message's reply leaves it so.
    woken.push(
      { type: 'start', messageId: 'reply-a' },
      { type: 'data-notice', data: { code: 'reply_failed' } } as UIMessageChunk,
      { type: 'finish' },
      { type: 'start', messageId: 'reply-b' },
      ...text('tb', SECOND_REPLY),
      { type: 'finish' }
    );
    woken.close();
    await advance(10);

    const saved = [
      OFFERED,
      user('u1', BUTTON_TEXT.try_again),
      assistant('reply-a', [{ type: 'data-notice', data: { code: 'reply_failed' } }]),
      user('u2', NUDGE),
      assistant('reply-b', [textPart(SECOND_REPLY)]),
    ];
    const reloaded = await reloadButtons(saved);
    expect(reloaded).toEqual(['0:quiz-try-again', '0:quiz-next']);
    expect(usableButtons(container)).toEqual(reloaded);
  });
});
