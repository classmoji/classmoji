import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

/**
 * Chat-transport helpers shared by the chat surfaces that read a Trigger chat
 * session's reply stream through useChat (the quiz chat, Ask Moji). Each is
 * generic over the surface's message type; none knows about quizzes. The
 * timing defaults of `watchReply` are the quiz chat's; a surface with other
 * turn limits passes its own.
 */

// ---------------------------------------------------------------------------
// Replies the transcript already shows
// ---------------------------------------------------------------------------

/**
 * The reply stream without the replies the chat already holds. The session's
 * reply stream keeps about the last reply, and the transport reads it from a
 * resume cursor; a tab without a good cursor (no session state stored in this
 * tab, a stale copy of it, a session the transport had to create again, or a
 * reload before the stored cursor was written) reads that last reply again
 * ahead of the new one. useChat would add it as another message with the same
 * id, then fold its parts into the new reply, so the previous turn showed up
 * twice or three times, and new text after its card was hidden. Every reply
 * opens with a `start` chunk naming its message id and closes with `finish`:
 * from a `start` whose id is already in the chat through its `finish` (or up
 * to the next `start`, for a reply cut short), the chunks are dropped.
 * Anything else passes as it is, a new turn's error before its own `start`
 * included.
 */
export const dropReplayedMessages = (
  stream: ReadableStream<UIMessageChunk>,
  knownIds: ReadonlySet<string>
): ReadableStream<UIMessageChunk> => {
  if (knownIds.size === 0) return stream;
  let replaying = false;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start') {
          replaying = typeof chunk.messageId === 'string' && knownIds.has(chunk.messageId);
        }
        if (!replaying) controller.enqueue(chunk);
        else if (chunk.type === 'finish') replaying = false;
      },
    })
  );
};

/**
 * The transport as useChat sees it: every reply stream passes through
 * `dropReplayedMessages`, against the messages sent with the request (a new
 * message) or the chat's messages as they are now (a resumed reply).
 */
export const withoutReplayedMessages = <M extends UIMessage>(
  transport: ChatTransport<M>,
  currentMessages: () => readonly M[]
): ChatTransport<M> => {
  const idsOf = (messages: readonly M[]) => new Set(messages.map(m => m.id));
  return {
    sendMessages: async options =>
      dropReplayedMessages(await transport.sendMessages(options), idsOf(options.messages)),
    reconnectToStream: async options => {
      const stream = await transport.reconnectToStream(options);
      return stream ? dropReplayedMessages(stream, idsOf(currentMessages())) : stream;
    },
  };
};

// ---------------------------------------------------------------------------
// Replies that never come
// ---------------------------------------------------------------------------

/**
 * How long a quiz reply may take to send its first chunk (`watchReply`'s
 * default `startMs`). A turn writes its `start` as it begins, before any
 * model call (the quiz task's loop.ts), and an ordinary reply shows text
 * within 5 to 30 seconds of the message; this is three times that. A run that
 * ended without reading the message (between turns, at its idle limit, in a
 * crash) sends nothing at all.
 */
export const REPLY_START_MS = 90_000;
/**
 * How long a quiz reply that has begun may go without a chunk (`watchReply`'s
 * default `silenceMs`): the quiz task's turn deadline (four minutes), with a
 * minute's margin. The stream carries no reasoning, so a turn that is
 * thinking can be silent for minutes, but no turn runs past its deadline: it
 * ends with a notice by then.
 */
export const REPLY_SILENCE_MS = 240_000 + 60_000;

/** `watchReply`'s waits, in milliseconds. */
export interface ReplyTimings {
  /** No chunk within this long of the start: quiet. Default `REPLY_START_MS`. */
  startMs?: number;
  /** No chunk within this long of the last chunk: quiet. Default `REPLY_SILENCE_MS`. */
  silenceMs?: number;
}

/** What ended a quiet: a chunk of the reply, the stream's own end, or `release`. */
export type QuietEnd = 'chunk' | 'ended' | 'released';

/** A reply stream as useChat reads it, watched for going quiet (`watchReply`). */
export interface WatchedReply {
  stream: ReadableStream<UIMessageChunk>;
  /** No chunk within the current wait; the stream is still read. */
  readonly quiet: boolean;
  /** A chunk of the reply has come. */
  readonly begun: boolean;
  /**
   * Stop reading the reply here: the transport's stream is cancelled, which
   * ends this tab's reading of it and nothing else (only an abort of the
   * request writes a stop, and stops the run's turn), and the stream ends as
   * a finished reply would.
   */
  release: () => void;
}

/**
 * Watches a reply stream for going quiet: no chunk within `startMs` of the
 * start, or within `silenceMs` of the last chunk. Quiet, the reply is still
 * read, so a late one shows as it comes; the chat takes a message meanwhile
 * (and releases the reply first: `release`). A chunk ends the quiet, and so
 * does the end of the stream; `onQuietChange` hears each change, and what
 * ended a quiet. A tab coming back into view waits afresh: its timers ran on
 * while it was hidden or asleep, and the transport reconnects then.
 */
export const watchReply = (
  source: ReadableStream<UIMessageChunk>,
  onQuietChange: (quiet: boolean, end?: QuietEnd) => void,
  { startMs = REPLY_START_MS, silenceMs = REPLY_SILENCE_MS }: ReplyTimings = {}
): WatchedReply => {
  const reader = source.getReader();
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  let begun = false;
  let quiet = false;
  const setQuiet = (next: boolean, end?: QuietEnd) => {
    if (quiet === next) return;
    quiet = next;
    onQuietChange(next, end);
  };
  const arm = () => {
    clearTimeout(timer);
    if (over || quiet) return;
    timer = setTimeout(() => setQuiet(true), begun ? silenceMs : startMs);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') arm();
  };
  const watching = typeof document !== 'undefined';
  /** Ends the watch, once: false when it had already ended. */
  const finish = (end: QuietEnd) => {
    if (over) return false;
    over = true;
    clearTimeout(timer);
    if (watching) document.removeEventListener('visibilitychange', onVisibility);
    setQuiet(false, end);
    return true;
  };
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c;
      arm();
      if (watching) document.addEventListener('visibilitychange', onVisibility);
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (over) return;
            if (done) {
              finish('ended');
              controller.close();
              return;
            }
            begun = true;
            setQuiet(false, 'chunk');
            arm();
            controller.enqueue(value);
          }
        } catch (error) {
          if (finish('ended')) controller.error(error);
        }
      })();
    },
    cancel(reason) {
      finish('ended');
      return reader.cancel(reason);
    },
  });
  return {
    stream,
    get quiet() {
      return quiet;
    },
    get begun() {
      return begun;
    },
    release: () => {
      if (!finish('released')) return;
      reader.cancel().catch(() => {});
      controller.close();
    },
  };
};

/**
 * The stream from its first `start` on: what comes before it (the rest of a
 * reply this tab stopped reading part way, which the stream reads on from)
 * is dropped, but for an error, which is the new turn's own.
 */
export const fromFirstStart = (
  stream: ReadableStream<UIMessageChunk>
): ReadableStream<UIMessageChunk> => {
  let started = false;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start') started = true;
        if (started || chunk.type === 'error') controller.enqueue(chunk);
      },
    })
  );
};

// ---------------------------------------------------------------------------
// Replies folded into the next one
// ---------------------------------------------------------------------------

/** Two parts with the same content. */
const samePart = <P>(a: P, b: P | undefined) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The chat with each reply useChat folded into the next one taken back out.
 * One reply stream can carry two replies: the message after one a run never
 * answered wakes a run that answers both, and both replies come on the new
 * message's stream (so does a turn a recovering run answers again). useChat
 * builds one message per stream: a second reply's `start` renames that
 * message and adds it again, holding the first reply's parts ahead of its
 * own. So an assistant message right after another that opens with all of
 * that one's parts holds them a second time, and they are dropped from it.
 */
export const withoutFoldedReplies = <M extends UIMessage>(messages: M[]): M[] => {
  let out: M[] | null = null;
  for (let i = 1; i < messages.length; i++) {
    const earlier = messages[i - 1];
    const later = messages[i];
    if (earlier.role !== 'assistant' || later.role !== 'assistant') continue;
    const held = earlier.parts.length;
    if (held === 0 || later.parts.length < held) continue;
    if (!earlier.parts.every((part, k) => samePart(part, later.parts[k]))) continue;
    out ??= messages.slice();
    out[i] = { ...later, parts: later.parts.slice(held) } as M;
  }
  return out ?? messages;
};
