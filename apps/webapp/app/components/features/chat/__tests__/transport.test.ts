// @vitest-environment jsdom
/**
 * The shared chat-transport helpers (`../transport`), over a plain AI SDK
 * message type, a surface's own typed message (data parts and metadata of its
 * own, as Ask Moji's will be) and the quiz chat's `QuizUIMessage`. The quiz
 * chat's component suites (QuizChat.replay, QuizChat.replyDeadline) cover the
 * same helpers wired into useChat.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';
import {
  REPLY_SILENCE_MS,
  REPLY_START_MS,
  dropReplayedMessages,
  fromFirstStart,
  watchReply,
  withoutFoldedReplies,
  withoutReplayedMessages,
} from '../transport';
import * as fromQuizChat from '../../quiz/QuizChat';

/** A surface's own message: metadata and a data part of its own. */
type CitedMessage = UIMessage<
  { pinned?: boolean },
  { citation: { pageId: string; title: string } }
>;

const streamOf = (chunks: unknown[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as UIMessageChunk);
      controller.close();
    },
  });

const read = async (stream: ReadableStream<UIMessageChunk>) => {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
};

/** A stream the test feeds by hand. */
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

const text = (id: string, value: string): UIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];

const replyChunks = (messageId: string, value: string): UIMessageChunk[] => [
  { type: 'start', messageId },
  { type: 'start-step' },
  ...text(`${messageId}-t`, value),
  { type: 'finish-step' },
  { type: 'finish' },
];

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

// ---------------------------------------------------------------------------
// The quiz chat's re-exports
// ---------------------------------------------------------------------------

describe('QuizChat re-exports', () => {
  it('re-exports every moved helper and constant as the same binding', () => {
    expect(fromQuizChat.dropReplayedMessages).toBe(dropReplayedMessages);
    expect(fromQuizChat.withoutReplayedMessages).toBe(withoutReplayedMessages);
    expect(fromQuizChat.fromFirstStart).toBe(fromFirstStart);
    expect(fromQuizChat.withoutFoldedReplies).toBe(withoutFoldedReplies);
    expect(fromQuizChat.watchReply).toBe(watchReply);
    expect(fromQuizChat.REPLY_START_MS).toBe(REPLY_START_MS);
    expect(fromQuizChat.REPLY_SILENCE_MS).toBe(REPLY_SILENCE_MS);
  });

  it("keeps the quiz chat's waits as the defaults", () => {
    expect(REPLY_START_MS).toBe(90_000);
    expect(REPLY_SILENCE_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// dropReplayedMessages / withoutReplayedMessages
// ---------------------------------------------------------------------------

describe('dropReplayedMessages', () => {
  const previous = replyChunks('a1', 'The previous answer.');
  const next = replyChunks('a2', 'The new answer.');

  it('drops each reply the chat already holds, through its finish', async () => {
    const out = await read(dropReplayedMessages(streamOf([...previous, ...next]), new Set(['a1'])));
    expect(out).toEqual(next);
  });

  it('passes a stream as it is when no id is known', async () => {
    const stream = streamOf(next);
    expect(dropReplayedMessages(stream, new Set())).toBe(stream);
  });

  it("keeps a new turn's error, and ends a replay cut short at the next start", async () => {
    const error = { type: 'error', errorText: 'Something went wrong.' };
    expect(
      await read(dropReplayedMessages(streamOf([...previous, error]), new Set(['a1'])))
    ).toEqual([error]);
    const cutShort = previous.slice(0, -1);
    expect(
      await read(dropReplayedMessages(streamOf([...cutShort, ...next]), new Set(['a1'])))
    ).toEqual(next);
  });
});

describe('withoutReplayedMessages', () => {
  const previous = replyChunks('a1', 'The previous answer.');
  const next = replyChunks('a2', 'The new answer.');

  const fakeTransport = <M extends UIMessage>() => ({
    sendMessages: vi.fn(async (_options: { messages: M[] }) => streamOf([...previous, ...next])),
    reconnectToStream: vi.fn(
      async (_options: unknown): Promise<ReadableStream<UIMessageChunk> | null> =>
        streamOf([...previous, ...next])
    ),
  });

  it('filters a plain message chat: sent replies against the request, resumed against the chat', async () => {
    const chat: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The previous answer.' }] },
    ];
    const transport = fakeTransport<UIMessage>();
    const guarded = withoutReplayedMessages(
      transport as unknown as ChatTransport<UIMessage>,
      () => chat
    );
    expectTypeOf(guarded).toEqualTypeOf<ChatTransport<UIMessage>>();

    const sent = await guarded.sendMessages({ chatId: 'c1', messages: chat } as never);
    expect(await read(sent)).toEqual(next);

    const resumed = await guarded.reconnectToStream({ chatId: 'c1' } as never);
    expect(resumed && (await read(resumed))).toEqual(next);

    transport.reconnectToStream.mockResolvedValueOnce(null);
    expect(await guarded.reconnectToStream({ chatId: 'c1' } as never)).toBeNull();
  });

  it("reads the chat's messages when a reply resumes, not when it was wrapped", async () => {
    let chat: CitedMessage[] = [];
    const transport = fakeTransport<CitedMessage>();
    const guarded = withoutReplayedMessages(
      transport as unknown as ChatTransport<CitedMessage>,
      () => chat
    );
    expectTypeOf(guarded).toEqualTypeOf<ChatTransport<CitedMessage>>();

    chat = [
      {
        id: 'a1',
        role: 'assistant',
        metadata: { pinned: true },
        parts: [{ type: 'data-citation', data: { pageId: 'p1', title: 'Flexbox' } }],
      },
    ];
    const resumed = await guarded.reconnectToStream({ chatId: 'c1' } as never);
    expect(resumed && (await read(resumed))).toEqual(next);
  });

  it('filters a quiz chat the same way', async () => {
    const chat = [
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The previous answer.' }] },
    ] as QuizUIMessage[];
    const transport = fakeTransport<QuizUIMessage>();
    const guarded = withoutReplayedMessages(
      transport as unknown as ChatTransport<QuizUIMessage>,
      () => chat
    );
    expectTypeOf(guarded).toEqualTypeOf<ChatTransport<QuizUIMessage>>();
    const resumed = await guarded.reconnectToStream({ chatId: 'attempt-1' } as never);
    expect(resumed && (await read(resumed))).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// fromFirstStart
// ---------------------------------------------------------------------------

describe('fromFirstStart', () => {
  it('drops the rest of a released reply ahead of the next start', async () => {
    const leftover = [...text('old', 'rest of the old reply'), { type: 'finish' }];
    const next = replyChunks('a2', 'The new answer.');
    expect(await read(fromFirstStart(streamOf([...leftover, ...next])))).toEqual(next);
  });

  it('keeps an error before the first start, and everything from the start on', async () => {
    const error = { type: 'error', errorText: 'Something went wrong.' };
    const next = replyChunks('a2', 'The new answer.');
    expect(await read(fromFirstStart(streamOf([...text('old', 'x'), error, ...next])))).toEqual([
      error,
      ...next,
    ]);
    // A later reply's start and chunks pass too, once started.
    const both = [...next, ...replyChunks('a3', 'And another.')];
    expect(await read(fromFirstStart(streamOf(both)))).toEqual(both);
  });
});

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

  it("waits the quiz chat's times by default", async () => {
    const source = controlled();
    const reply = watchReply(source.stream, () => {});
    drain(reply.stream);

    await vi.advanceTimersByTimeAsync(REPLY_START_MS - 1);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);

    source.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(reply.quiet).toBe(false);
    expect(reply.begun).toBe(true);
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);
  });

  it('takes its own start and silence waits', async () => {
    const source = controlled();
    const changes: Array<[boolean, string | undefined]> = [];
    const reply = watchReply(source.stream, (quiet, end) => changes.push([quiet, end]), {
      startMs: 1_000,
      silenceMs: 5_000,
    });
    const { got } = drain(reply.stream);

    await vi.advanceTimersByTimeAsync(999);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);

    source.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);
    expect(changes).toEqual([
      [true, undefined],
      [false, 'chunk'],
      [true, undefined],
    ]);
    expect(got).toEqual([{ type: 'start', messageId: 'r1' }]);
  });

  it('takes one wait and keeps the default for the other', async () => {
    const source = controlled();
    const reply = watchReply(source.stream, () => {}, { startMs: 10 });
    drain(reply.stream);
    await vi.advanceTimersByTimeAsync(10);
    expect(reply.quiet).toBe(true);
    source.push({ type: 'start', messageId: 'r1' });
    await vi.advanceTimersByTimeAsync(REPLY_SILENCE_MS - 1);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reply.quiet).toBe(true);
  });

  it('passes the stream through and ends with it, then never goes quiet', async () => {
    const source = controlled();
    const changes: Array<[boolean, string | undefined]> = [];
    const reply = watchReply(source.stream, (quiet, end) => changes.push([quiet, end]), {
      startMs: 100,
      silenceMs: 100,
    });
    const { got, state } = drain(reply.stream);
    const chunks = replyChunks('r1', 'Close: say which axis.');
    for (const chunk of chunks) {
      source.push(chunk);
      await vi.advanceTimersByTimeAsync(99);
    }
    source.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(chunks);
    expect(state.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(changes).toEqual([]);
  });

  it('release cancels the source and ends the stream as a finished reply', async () => {
    const source = controlled();
    const changes: Array<[boolean, string | undefined]> = [];
    const reply = watchReply(source.stream, (quiet, end) => changes.push([quiet, end]), {
      startMs: 100,
    });
    const { state } = drain(reply.stream);
    await vi.advanceTimersByTimeAsync(100);
    reply.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.cancelled).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.error).toBeUndefined();
    expect(changes).toEqual([
      [true, undefined],
      [false, 'released'],
    ]);
    reply.release();
    expect(changes).toHaveLength(2);
  });

  it('waits afresh when the tab comes back into view', async () => {
    const source = controlled();
    const reply = watchReply(source.stream, () => {}, { startMs: 1_000, silenceMs: 1_000 });
    drain(reply.stream);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(900);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(900);
    expect(reply.quiet).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(reply.quiet).toBe(true);
  });

  it("passes the source's error on, and a reader's cancel to the source", async () => {
    const failing = controlled();
    const onQuietChange = vi.fn();
    const failed = watchReply(failing.stream, onQuietChange, { startMs: 100, silenceMs: 100 });
    const { state } = drain(failed.stream);
    const error = new Error('stream failed');
    failing.fail(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.error).toBe(error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onQuietChange).not.toHaveBeenCalled();

    const source = controlled();
    const watched = watchReply(source.stream, onQuietChange, { startMs: 100 });
    await watched.stream.cancel('done');
    expect(source.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onQuietChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withoutFoldedReplies
// ---------------------------------------------------------------------------

describe('withoutFoldedReplies', () => {
  const textPart = (value: string) => ({
    type: 'text' as const,
    text: value,
    state: 'done' as const,
  });

  it('unfolds replies of a plain message chat, keeping ids and types', () => {
    const a: UIMessage = { id: 'a', role: 'assistant', parts: [textPart('One.')] };
    const b: UIMessage = { id: 'b', role: 'assistant', parts: [...a.parts, textPart('Two.')] };
    const messages: UIMessage[] = [{ id: 'u1', role: 'user', parts: [textPart('x')] }, a, b];
    const out = withoutFoldedReplies(messages);
    expectTypeOf(out).toEqualTypeOf<UIMessage[]>();
    expect(out[1]).toBe(a);
    expect(out[2]).toEqual({ id: 'b', role: 'assistant', parts: [textPart('Two.')] });
    // The input is not changed.
    expect(messages[2]).toBe(b);
  });

  it("compares a surface's own data parts by content, and keeps its metadata", () => {
    const citation = { pageId: 'p1', title: 'Flexbox' };
    const a: CitedMessage = {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'data-citation', data: citation }],
    };
    const b: CitedMessage = {
      id: 'b',
      role: 'assistant',
      metadata: { pinned: true },
      // An equal copy, not the same object.
      parts: [{ type: 'data-citation', data: { ...citation } }, textPart('See that page.')],
    };
    const out = withoutFoldedReplies([a, b]);
    expectTypeOf(out).toEqualTypeOf<CitedMessage[]>();
    expect(out[1]).toEqual({
      id: 'b',
      role: 'assistant',
      metadata: { pinned: true },
      parts: [textPart('See that page.')],
    });
  });

  it('unfolds a chain of quiz replies, each against the one before it as it came', () => {
    const assistant = (id: string, parts: unknown[]) =>
      ({ id, role: 'assistant', parts }) as unknown as QuizUIMessage;
    const offerPart = (callId: string) => ({
      type: 'tool-offer_next_step',
      toolCallId: callId,
      state: 'output-available',
      input: { actions: ['try_again', 'next'], feedback: 'Not quite.' },
      output: { actions: ['try_again', 'next'] },
    });
    const a = assistant('a', [offerPart('c1')]);
    const b = assistant('b', [...a.parts, textPart('Two.')]);
    const c = assistant('c', [...b.parts, offerPart('c2')]);
    const out = withoutFoldedReplies([a, b, c]);
    expectTypeOf(out).toEqualTypeOf<QuizUIMessage[]>();
    expect(out.map(m => m.parts)).toEqual([
      [offerPart('c1')],
      [textPart('Two.')],
      [offerPart('c2')],
    ]);
  });

  it('leaves a chat without folded replies as it is', () => {
    const messages: UIMessage[] = [
      { id: 'a', role: 'assistant', parts: [textPart('Same.')] },
      { id: 'b', role: 'assistant', parts: [textPart('Other.'), textPart('Same.')] },
      { id: 'u', role: 'user', parts: [textPart('Hi.')] },
      { id: 'c', role: 'assistant', parts: [textPart('Same.')] },
    ];
    expect(withoutFoldedReplies(messages)).toBe(messages);
    const empty: UIMessage[] = [
      { id: 'a', role: 'assistant', parts: [] },
      { id: 'b', role: 'assistant', parts: [textPart('Hi.')] },
    ];
    expect(withoutFoldedReplies(empty)).toBe(empty);
  });
});
