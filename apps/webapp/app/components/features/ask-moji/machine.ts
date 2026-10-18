/**
 * The pure half of the Ask Moji panel's state machine: the decisions the
 * controller (./controller.ts) takes, as plain functions of what it knows,
 * and the transport wrapper every reply stream passes through. Nothing here
 * touches React, the DOM or the network.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import {
  ASK_MOJI_COPY,
  ASK_MOJI_REFUSALS,
  AskMojiViewingSchema,
  TURN_DEADLINE_MS,
  askMojiCopyFor,
  isAskMojiErrorCopy,
  type AskMojiCopyCode,
  type AskMojiUIMessage,
  type AskMojiViewing,
} from '@classmoji/utils/ask-moji';
import {
  dropReplayedMessages,
  fromFirstStart,
  watchReply,
  type ReplyTimings,
  type WatchedReply,
} from '../chat/transport';
import type { AskMojiState } from './api';

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * The reply watchdog (`watchReply`): 90 s to the first chunk (a turn writes
 * its `start` before any model call), then the task's turn deadline plus a
 * minute of silence. Past either, the reply is released and the server's
 * state decides what happened.
 */
export const ASK_MOJI_REPLY_TIMINGS: Required<ReplyTimings> = {
  startMs: 90_000,
  silenceMs: TURN_DEADLINE_MS + 60_000,
};

// ---------------------------------------------------------------------------
// The server's transcript vs ours
// ---------------------------------------------------------------------------

/** Whether a message holds answer text (not only steps or notices). */
export const hasAnswerText = (m: UIMessage | undefined): boolean =>
  Boolean(
    m &&
    m.role === 'assistant' &&
    m.parts.some(p => p.type === 'text' && (p as { text?: string }).text?.trim())
  );

/** The text of a message's text parts, joined (a user's question; an answer's Markdown). */
export const textOf = (m: UIMessage | undefined): string =>
  (m?.parts ?? [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('\n\n')
    .trim();

/**
 * Whether this tab is AHEAD of the server: it read a reply to its end (a
 * `finish` chunk, not released by the watchdog) that the server has not
 * stored yet. The task persists a reply after its stream ends, so a state
 * read right after the finish still lists the turn in flight with a
 * transcript ending at the question. Adopting that transcript would wipe the
 * answer just read; resuming would read it twice.
 */
export function isAhead(
  local: readonly UIMessage[],
  serverIds: ReadonlySet<string>,
  lastFinishClean: boolean
): boolean {
  if (!lastFinishClean) return false;
  const last = local.at(-1);
  return Boolean(last && last.role === 'assistant' && !serverIds.has(last.id));
}

export type StateDecision =
  /** The conversation is gone for this caller (null state): stop, say so. */
  | { type: 'ended' }
  /** Another device moved this view to a newer conversation: open that one. */
  | { type: 'switch'; conversationId: string }
  /** Ours was ended and nothing replaced it. */
  | { type: 'ended-no-next' }
  /**
   * Stay: `adopt` the server's transcript (when it came and we are not ahead),
   * `resume` the reply stream (a turn in flight we are not already holding).
   */
  | { type: 'stay'; adopt: boolean; resume: boolean; ahead: boolean };

/** What one `state` answer means for the conversation the panel is on. */
export function decideState(i: {
  conversationId: string;
  state: AskMojiState | null;
  local: readonly UIMessage[];
  confirmedIds: ReadonlySet<string>;
  lastFinishClean: boolean;
}): StateDecision {
  const { state } = i;
  if (!state) return { type: 'ended' };
  if (state.status !== 'ACTIVE' || state.conversationId !== i.conversationId) {
    return state.conversationId && state.conversationId !== i.conversationId
      ? { type: 'switch', conversationId: state.conversationId }
      : { type: 'ended-no-next' };
  }
  const serverIds = state.transcript ? new Set(state.transcript.map(m => m.id)) : i.confirmedIds;
  const ahead = isAhead(i.local, serverIds, i.lastFinishClean);
  if (ahead && state.inFlight) return { type: 'stay', adopt: false, resume: false, ahead };
  return { type: 'stay', adopt: Boolean(state.transcript), resume: state.inFlight, ahead };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** The line a failed request or reply shows: its text when it is fixed copy, else the generic line. */
export const lineForError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : undefined;
  const line = (error as { line?: unknown } | null)?.line;
  if (isAskMojiErrorCopy(line)) return line;
  return isAskMojiErrorCopy(message) ? message : ASK_MOJI_COPY.ERROR;
};

/** The line for a `data-notice` code (unknown codes get the generic line). */
export const lineForNotice = (code: string): string => askMojiCopyFor(code);

/** Codes after which the conversation takes no more turns (the task closes it). */
export const isEndingCode = (code: string | null | undefined): boolean =>
  typeof code === 'string' &&
  Object.prototype.hasOwnProperty.call(ASK_MOJI_REFUSALS, code) &&
  ASK_MOJI_REFUSALS[code as keyof typeof ASK_MOJI_REFUSALS] === 'permanent';

/** Every notice code but the busy hint means "no answer came": the question goes back. */
export const restoresQuestion = (code: AskMojiCopyCode | string | null): boolean =>
  code !== 'BUSY_ELSEWHERE';

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------

/** What a message carries as its `viewing`: kind, id and slide only, checked; else null. */
export function wireViewing(
  v: { kind: string; id?: string | null; slide?: number | null } | null | undefined
): AskMojiViewing | null {
  if (!v) return null;
  const candidate: Record<string, unknown> = { kind: v.kind };
  if (typeof v.id === 'string' && v.id) candidate.id = v.id;
  if (v.kind === 'deck' && typeof v.slide === 'number') candidate.slide = v.slide;
  const parsed = AskMojiViewingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** A stable key for a viewing (dismissal is per viewing and per message). */
export const viewingKey = (v: AskMojiViewing | null) =>
  v ? `${v.kind}:${v.id ?? ''}:${v.slide ?? ''}` : '';

// ---------------------------------------------------------------------------
// The transport useChat reads replies through
// ---------------------------------------------------------------------------

export interface ReplyHooks {
  /** The ids the server has confirmed (its last transcript): replays of these are dropped. */
  knownIds: () => ReadonlySet<string>;
  /** Called with each reply stream as it opens; `sawFinish` reads whether its `finish` came. */
  onReply: (reply: WatchedReply, sawFinish: () => boolean) => void;
  /** The reply went quiet (or a chunk ended the quiet). */
  onQuiet: (reply: WatchedReply, quiet: boolean) => void;
  timings?: ReplyTimings;
}

/**
 * The Trigger transport as the Chat sees it. Every reply stream:
 *   1. (a new message only) starts at its first `start` (`fromFirstStart`),
 *      so the rest of a reply this tab stopped reading is not folded in;
 *   2. drops replies the server has already confirmed (`dropReplayedMessages`
 *      against server-confirmed ids, never the chat's own optimistic ones);
 *   3. notes whether its `finish` came;
 *   4. is watched for going quiet (`watchReply`).
 */
export function askMojiChatTransport<M extends UIMessage = AskMojiUIMessage>(
  base: ChatTransport<M>,
  hooks: ReplyHooks
): ChatTransport<M> {
  const prepare = (stream: ReadableStream<UIMessageChunk>, newMessage: boolean) => {
    let finished = false;
    const guarded = dropReplayedMessages(
      newMessage ? fromFirstStart(stream) : stream,
      hooks.knownIds()
    ).pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === 'finish') finished = true;
          controller.enqueue(chunk);
        },
      })
    );
    const reply: WatchedReply = watchReply(
      guarded,
      quiet => hooks.onQuiet(reply, quiet),
      hooks.timings ?? ASK_MOJI_REPLY_TIMINGS
    );
    hooks.onReply(reply, () => finished);
    return reply.stream;
  };
  return {
    sendMessages: async options => prepare(await base.sendMessages(options), true),
    reconnectToStream: async options => {
      const stream = await base.reconnectToStream(options);
      return stream ? prepare(stream, false) : stream;
    },
  };
}
