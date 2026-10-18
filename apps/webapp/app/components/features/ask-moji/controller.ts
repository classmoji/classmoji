/**
 * The Ask Moji panel's state machine (R13), one per classroom and view.
 *
 * It owns the conversation the panel is on: one externally managed `Chat`
 * per conversation (`useChat({ chat })` then never stops it on unmount), the
 * Trigger transport's session state for it, and everything the server says
 * about it. Opening and closing the panel only start and stop the poll; a
 * reply keeps streaming while the panel is closed. Moving to another
 * conversation swaps the Chat and never calls `stop`.
 *
 *   open   `start` → `setSession` when the server says a Trigger session
 *          exists (`sessionReady`), else the transport's `startSession`
 *          (→ `ensure-session`) creates it on composer focus or the first
 *          send → the Chat, seeded with the transcript → `resumeStream()`
 *          when a turn is in flight.
 *   poll   every `STATE_POLL_MS` while open and visible, and on becoming
 *          visible. Acts only while the Chat is idle (`ready`): moves to a
 *          newer conversation (another device's New conversation), adopts a
 *          newer transcript (re-seeding the resume cursor), joins a turn in
 *          flight.
 *   send   `state` first: a turn in flight anywhere is joined, and the line
 *          says so (`BUSY_ELSEWHERE`); else `sendMessage({ text, metadata:
 *          { viewing } })` (viewing on the message, never request options).
 *   end    of a turn: the server's transcript replaces ours (`decideState`
 *          keeps ours while the server has not stored the reply yet).
 *   quiet  `watchReply` (90 s to the first chunk, deadline + 60 s of
 *          silence): the reply is released and the state decides.
 *
 * The replay guard's known ids are the server-confirmed ids (its last
 * transcript), never the chat's optimistic ones.
 */
import { Chat } from '@ai-sdk/react';
import type { ChatTransport } from 'ai';
import {
  ASK_MOJI_COPY,
  MAX_MESSAGE_CHARS,
  STATE_POLL_MS,
  type AskMojiSuggestion,
  type AskMojiUIMessage,
  type AskMojiViewing,
} from '@classmoji/utils/ask-moji';
import type { ReplyTimings, WatchedReply } from '../chat/transport';
import { AskMojiApiError, type AskMojiApi, type AskMojiOpened, type AskMojiRating } from './api';
import {
  askMojiChatTransport,
  decideState,
  hasAnswerText,
  isEndingCode,
  lineForError,
  lineForNotice,
  restoresQuestion,
  textOf,
} from './machine';

/** The Trigger transport surface the controller uses (TriggerChatTransport has all of it). */
export interface AskMojiSessionTransport extends ChatTransport<AskMojiUIMessage> {
  getSession(chatId: string):
    | {
        publicAccessToken: string;
        lastEventId?: string;
        activeInputSeq?: number;
        isStreaming?: boolean;
        closed?: boolean;
      }
    | undefined;
  setSession(
    chatId: string,
    session: { publicAccessToken: string; lastEventId?: string; isStreaming?: boolean }
  ): void;
  seedResumeCursor(chatId: string, lastEventId: string): void;
  preload(chatId: string): Promise<void>;
  sessionStatus(chatId: string): 'open' | 'closed';
}

export type AskMojiPhase =
  /** Nothing asked for yet (the panel has never been opened). */
  | 'idle'
  | 'starting'
  | 'ready'
  /** The conversation takes no more turns; New conversation goes on. */
  | 'ended'
  /** Ask Moji is not available here (start refused). */
  | 'unavailable'
  /** Start failed; Try again. */
  | 'failed';

export interface AskMojiSnapshot {
  phase: AskMojiPhase;
  conversationId: string | null;
  chat: Chat<AskMojiUIMessage> | null;
  welcome: string;
  suggestions: readonly AskMojiSuggestion[];
  ratings: Readonly<Record<string, AskMojiRating>>;
  /** The server says a turn is in flight (this tab's or another's). */
  serverInFlight: boolean;
  /** That turn was not sent from this tab. */
  busyElsewhere: boolean;
  /** A request of the controller's own is running (state check before a send, New conversation). */
  working: boolean;
  /** Fixed copy: what went wrong, or why the conversation can't go on. */
  line: string | null;
  /** Why Ask Moji is unavailable, for OWNER/TEACHER (fixed staff copy). */
  staffLine: string | null;
  /** A question to put back in the composer (its turn got no answer). */
  restore: { text: string; nonce: number } | null;
}

export interface AskMojiControllerOptions {
  api: AskMojiApi;
  transport: AskMojiSessionTransport;
  /** The view the URL asks for (a role), or null (the embed: the server picks the highest held). */
  viewAs: string | null;
  browserTimeZone?: () => string | null;
  /** Tests inject a Chat factory; the app uses `new Chat`. */
  createChat?: (
    init: ConstructorParameters<typeof Chat<AskMojiUIMessage>>[0]
  ) => Chat<AskMojiUIMessage>;
  pollMs?: number;
  replyTimings?: ReplyTimings;
}

interface Conversation {
  id: string;
  chat: Chat<AskMojiUIMessage>;
  /** The server's last-known latest message id (what `state` compares against). */
  knownLastMessageId: string | null;
  /** The ids of the server's last transcript: the replay guard's known ids. */
  confirmedIds: Set<string>;
}

const EMPTY_SNAPSHOT: AskMojiSnapshot = {
  phase: 'idle',
  conversationId: null,
  chat: null,
  welcome: '',
  suggestions: [],
  ratings: {},
  serverInFlight: false,
  busyElsewhere: false,
  working: false,
  line: null,
  staffLine: null,
  restore: null,
};

const UNAVAILABLE_CODES = new Set(['UNAVAILABLE', 'NOT_ENABLED', 'NOT_A_MEMBER', 'SIGNED_OUT']);

export class AskMojiController {
  private readonly api: AskMojiApi;
  private readonly transport: AskMojiSessionTransport;
  private readonly viewAs: string | null;
  private readonly zone: () => string | null;
  private readonly createChat: NonNullable<AskMojiControllerOptions['createChat']>;
  private readonly pollMs: number;
  private readonly replyTimings: ReplyTimings | undefined;

  private snapshot: AskMojiSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private conv: Conversation | null = null;

  private isOpen = false;
  private isVisible = true;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** One request of ours at a time (start, state, send check, New conversation). */
  private busyRequest = false;
  /** A turn this tab sent, from `sendMessage` to its `onFinish`. */
  private turnPending = false;
  /** A `resumeStream()` this controller started and that has not settled. */
  private resuming = false;
  /** This tab watched the turn in flight (sent or joined it), so its outcome is ours to report. */
  private watchingTurn = false;
  /** The turn in flight was sent from this tab (until the server reports it settled). */
  private ownTurn = false;
  /** The last reply this tab read ended with its `finish` and was not released. */
  private lastFinishClean = false;
  /** The reply stream read now, and whether the watchdog released it. */
  private reply: { watched: WatchedReply; sawFinish: () => boolean; released: boolean } | null =
    null;
  /** A `data-notice` code the current turn carried. */
  private pendingNotice: string | null = null;
  private restoreNonce = 0;
  private rateSeq = new Map<string, number>();

  constructor(options: AskMojiControllerOptions) {
    this.api = options.api;
    this.transport = options.transport;
    this.viewAs = options.viewAs;
    this.zone = options.browserTimeZone ?? (() => null);
    this.createChat = options.createChat ?? (init => new Chat<AskMojiUIMessage>(init));
    this.pollMs = options.pollMs ?? STATE_POLL_MS;
    this.replyTimings = options.replyTimings;
  }

  // ─── Store protocol (useSyncExternalStore) ────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<AskMojiSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ─── Open / close / visibility ───────────────────────────────────────────

  /** The panel opened: start (first time, or after a failure) or catch up. */
  open() {
    this.isOpen = true;
    const { phase } = this.snapshot;
    if (phase === 'idle' || phase === 'failed' || phase === 'unavailable') void this.start();
    else void this.sync();
    this.updatePolling();
  }

  /** The panel closed: the poll stops; a reply keeps streaming. */
  close() {
    this.isOpen = false;
    this.updatePolling();
  }

  /** The document's visibility (the transport reconnects on its own; this drives the poll). */
  setVisible(visible: boolean) {
    const was = this.isVisible;
    this.isVisible = visible;
    if (visible && !was && this.isOpen) void this.sync();
    this.updatePolling();
  }

  /** Start the Trigger session early (composer focus), when none exists yet. */
  preload() {
    const conv = this.conv;
    if (!conv || this.snapshot.phase !== 'ready') return;
    if (this.transport.getSession(conv.id)) return;
    this.transport.preload(conv.id).catch(() => {});
  }

  /** Try a failed start again. */
  retry() {
    if (this.snapshot.phase === 'failed') void this.start();
  }

  /** The provider mounted (again: StrictMode mounts twice). */
  mount() {
    this.disposed = false;
    this.updatePolling();
  }

  /** The provider unmounted: the poll stops and late answers are dropped. The Chat is not stopped. */
  unmount() {
    this.disposed = true;
    this.updatePolling();
  }

  private updatePolling() {
    const should =
      !this.disposed &&
      this.isOpen &&
      this.isVisible &&
      this.conv !== null &&
      (this.snapshot.phase === 'ready' || this.snapshot.phase === 'ended');
    if (should && !this.timer) {
      this.timer = setInterval(() => void this.sync(), this.pollMs);
    } else if (!should && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── Derived ──────────────────────────────────────────────────────────────

  /** The Chat is reading or about to read a reply. */
  private chatBusy() {
    const status = this.conv?.chat.status;
    return this.turnPending || this.resuming || status === 'submitted' || status === 'streaming';
  }

  /** Answering anywhere: New conversation waits for it. */
  isAnswering() {
    return this.chatBusy() || this.snapshot.serverInFlight;
  }

  // ─── Start and install ───────────────────────────────────────────────────

  private async start() {
    if (this.busyRequest || this.disposed) return;
    this.busyRequest = true;
    this.set({ phase: 'starting', working: true, line: null, staffLine: null });
    try {
      const opened = await this.api.start({ viewAs: this.viewAs, browserTimeZone: this.zone() });
      if (this.disposed) return;
      this.install(opened);
    } catch (error) {
      if (this.disposed) return;
      this.failStart(error);
    } finally {
      this.busyRequest = false;
      if (!this.disposed) this.set({ working: false });
      this.updatePolling();
    }
  }

  private failStart(error: unknown) {
    const apiError = error instanceof AskMojiApiError ? error : null;
    if (apiError && apiError.code && UNAVAILABLE_CODES.has(apiError.code)) {
      this.set({ phase: 'unavailable', line: apiError.line, staffLine: apiError.staffLine });
      return;
    }
    this.set({ phase: 'failed', line: apiError?.line ?? ASK_MOJI_COPY.INIT_FAILED });
  }

  /** Put a conversation from `start` / `new` on screen. The previous Chat is dropped, never stopped. */
  private install(opened: AskMojiOpened) {
    const id = opened.conversationId;
    if (opened.sessionReady) {
      this.transport.setSession(id, {
        publicAccessToken: opened.publicAccessToken,
        ...(opened.resumeCursor ? { lastEventId: opened.resumeCursor } : {}),
        isStreaming: opened.state.inFlight,
      });
    } else if (opened.resumeCursor) {
      this.transport.seedResumeCursor(id, opened.resumeCursor);
    }

    const conv: Conversation = {
      id,
      chat: null as unknown as Chat<AskMojiUIMessage>,
      knownLastMessageId: opened.state.lastMessageId,
      confirmedIds: new Set(opened.transcript.map(m => m.id)),
    };
    conv.chat = this.createChat({
      id,
      messages: opened.transcript,
      transport: askMojiChatTransport<AskMojiUIMessage>(this.transport, {
        knownIds: () => conv.confirmedIds,
        onReply: (watched, sawFinish) => {
          if (this.conv === conv) this.reply = { watched, sawFinish, released: false };
        },
        onQuiet: (watched, quiet) => {
          if (!quiet || this.conv !== conv) return;
          if (this.reply?.watched === watched) this.reply.released = true;
          watched.release();
        },
        ...(this.replyTimings ? { timings: this.replyTimings } : {}),
      }),
      onData: part => {
        if (this.conv !== conv) return;
        if (part.type === 'data-notice') {
          const code = (part.data as { code?: unknown })?.code;
          if (typeof code === 'string') this.pendingNotice = code;
        }
      },
      onFinish: ({ isAbort, isError }) => this.onTurnEnd(conv, { isAbort, isError }),
    });

    this.conv = conv;
    this.turnPending = false;
    this.resuming = false;
    this.watchingTurn = false;
    this.ownTurn = false;
    this.lastFinishClean = false;
    this.reply = null;
    this.pendingNotice = null;
    this.set({
      phase: 'ready',
      conversationId: id,
      chat: conv.chat,
      welcome: opened.welcome,
      suggestions: opened.suggestions,
      ratings: { ...opened.ratings },
      serverInFlight: opened.state.inFlight,
      busyElsewhere: opened.state.inFlight,
      line: null,
      staffLine: null,
      restore: null,
    });
    if (opened.state.inFlight) {
      void this.join(conv, { cursor: opened.resumeCursor, adopted: true });
    }
  }

  // ─── Turn end ─────────────────────────────────────────────────────────────

  private onTurnEnd(
    conv: Conversation,
    { isAbort, isError }: { isAbort: boolean; isError: boolean }
  ) {
    if (this.conv !== conv) return;
    const chat = conv.chat;
    const reply = this.reply;
    this.reply = null;
    this.turnPending = false;
    this.lastFinishClean = Boolean(
      reply && reply.sawFinish() && !reply.released && !isAbort && !isError
    );

    const notice = this.pendingNotice;
    this.pendingNotice = null;
    const error = chat.error;
    let line: string | null = null;
    let ended = false;
    if (notice) {
      line = lineForNotice(notice);
      ended = isEndingCode(notice);
    } else if (isError && error) {
      line = lineForError(error);
    }
    if (this.transport.sessionStatus(conv.id) === 'closed') {
      ended = true;
      line ??= ASK_MOJI_COPY.CONVERSATION_ENDED;
    }
    if (chat.status === 'error') chat.clearError();

    const patch: Partial<AskMojiSnapshot> = {};
    if (line) {
      patch.line = line;
      if (!hasAnswerText(chat.messages.at(-1)) && restoresQuestion(notice)) {
        const question = textOf(lastUserMessage(chat.messages));
        if (question) patch.restore = { text: question, nonce: ++this.restoreNonce };
      }
    }
    if (ended) patch.phase = 'ended';
    this.set(patch);
    this.updatePolling();
    // The server's transcript replaces ours once it has the reply.
    setTimeout(() => void this.sync(), 0);
  }

  // ─── Sync (poll) ──────────────────────────────────────────────────────────

  /** One poll: act on the server's state while the Chat is idle. */
  async sync() {
    const conv = this.conv;
    if (!conv || this.disposed || this.busyRequest || this.chatBusy()) return;
    if (conv.chat.status !== 'ready') return;
    this.busyRequest = true;
    try {
      const state = await this.api.state({
        conversationId: conv.id,
        knownLastMessageId: conv.knownLastMessageId,
      });
      if (this.conv !== conv || this.disposed || this.chatBusy()) return;
      await this.apply(conv, state);
    } catch {
      // A failed poll changes nothing; the next one tries again.
    } finally {
      this.busyRequest = false;
    }
  }

  /**
   * Act on one `state` answer. Returns true when the panel stays on this
   * conversation with no turn in flight (a send may go ahead).
   */
  private async apply(
    conv: Conversation,
    state: Awaited<ReturnType<AskMojiApi['state']>>
  ): Promise<boolean> {
    const decision = decideState({
      conversationId: conv.id,
      state,
      local: conv.chat.messages,
      confirmedIds: conv.confirmedIds,
      lastFinishClean: this.lastFinishClean,
    });
    if (decision.type === 'ended') {
      this.set({ phase: 'ended', line: ASK_MOJI_COPY.CONVERSATION_ENDED, serverInFlight: false });
      this.updatePolling();
      return false;
    }
    if (decision.type === 'ended-no-next') {
      this.set({ phase: 'ended', line: ASK_MOJI_COPY.CONVERSATION_ENDED, serverInFlight: false });
      this.updatePolling();
      return false;
    }
    if (decision.type === 'switch') {
      await this.moveToActive();
      return false;
    }
    const s = state!;
    if (decision.adopt && s.transcript) {
      conv.chat.messages = s.transcript;
      conv.confirmedIds = new Set(s.transcript.map(m => m.id));
      conv.knownLastMessageId = s.lastMessageId;
      this.lastFinishClean = false;
    } else if (!s.transcript) {
      conv.knownLastMessageId = s.lastMessageId;
    }

    const patch: Partial<AskMojiSnapshot> = {
      serverInFlight: s.inFlight,
      busyElsewhere: s.inFlight && !this.ownTurn,
    };
    if (!s.inFlight) {
      // A turn this tab watched settled with no answer stored: it failed.
      const line = this.snapshot.line === ASK_MOJI_COPY.BUSY_ELSEWHERE ? null : this.snapshot.line;
      patch.line = line;
      if (this.watchingTurn && decision.adopt) {
        const last = conv.chat.messages.at(-1);
        if (last?.role === 'user' && !line) {
          patch.line = ASK_MOJI_COPY.REPLY_FAILED;
          const question = textOf(last);
          if (question) patch.restore = { text: question, nonce: ++this.restoreNonce };
        }
      }
      this.watchingTurn = false;
      this.ownTurn = false;
    }
    this.set(patch);

    if (decision.resume) {
      await this.join(conv, { cursor: s.resumeCursor, adopted: decision.adopt });
      return false;
    }
    if (decision.adopt && s.resumeCursor) this.reseed(conv.id, s.resumeCursor);
    return !s.inFlight;
  }

  /** The cursor after an adopted transcript: past the last reply the transcript holds. */
  private reseed(id: string, cursor: string) {
    const existing = this.transport.getSession(id);
    if (existing) {
      this.transport.setSession(id, {
        publicAccessToken: existing.publicAccessToken,
        lastEventId: cursor,
        isStreaming: false,
      });
    } else {
      this.transport.seedResumeCursor(id, cursor);
    }
  }

  /**
   * Read a turn in flight: make sure the transport holds a session marked as
   * streaming (a token when it has none), then `resumeStream()`.
   */
  private async join(conv: Conversation, i: { cursor: string | null; adopted: boolean }) {
    if (this.resuming || this.turnPending) return;
    const existing = this.transport.getSession(conv.id);
    if (existing?.closed) return;
    try {
      const token = existing
        ? existing.publicAccessToken
        : (await this.api.token({ conversationId: conv.id })).publicAccessToken;
      if (this.conv !== conv) return;
      // Our own place in the stream stands unless the transcript was just replaced.
      const lastEventId = i.adopted ? (i.cursor ?? undefined) : existing?.lastEventId;
      this.transport.setSession(conv.id, {
        publicAccessToken: token,
        ...(lastEventId ? { lastEventId } : {}),
        isStreaming: true,
      });
    } catch {
      return;
    }
    this.watchingTurn = true;
    this.resuming = true;
    // Not awaited: it settles when the reply ends, and nothing waits on that.
    void conv.chat
      .resumeStream()
      .catch(() => {})
      .finally(() => {
        if (this.conv === conv) this.resuming = false;
      });
  }

  /** Another device moved this view on: open its conversation (`start` reuses it). */
  private async moveToActive() {
    try {
      const opened = await this.api.start({ viewAs: this.viewAs, browserTimeZone: this.zone() });
      if (!this.disposed) this.install(opened);
    } catch (error) {
      if (!this.disposed) this.set({ phase: 'ended', line: lineForError(error) });
    } finally {
      this.updatePolling();
    }
  }

  // ─── Send ─────────────────────────────────────────────────────────────────

  /**
   * Send a question. Checks `state` first: a turn in flight anywhere is
   * joined instead (`BUSY_ELSEWHERE`). Resolves true when the message went.
   */
  async send(text: string, viewing: AskMojiViewing | null): Promise<boolean> {
    const conv = this.conv;
    const question = text.trim();
    if (!conv || this.snapshot.phase !== 'ready') return false;
    if (!question || question.length > MAX_MESSAGE_CHARS) return false;
    if (this.busyRequest || this.chatBusy() || conv.chat.status !== 'ready') return false;
    this.busyRequest = true;
    this.set({ working: true });
    try {
      const state = await this.api.state({
        conversationId: conv.id,
        knownLastMessageId: conv.knownLastMessageId,
      });
      if (this.conv !== conv || this.disposed) return false;
      if (state?.inFlight && state.status === 'ACTIVE' && state.conversationId === conv.id) {
        // Answering elsewhere: join that turn; the question stays in the composer.
        this.set({ line: ASK_MOJI_COPY.BUSY_ELSEWHERE });
        await this.apply(conv, state);
        return false;
      }
      const clear = await this.apply(conv, state);
      if (!clear || this.conv !== conv || this.snapshot.phase !== 'ready') return false;
      this.set({ line: null, restore: null, busyElsewhere: false });
      this.turnPending = true;
      this.watchingTurn = true;
      this.ownTurn = true;
      this.lastFinishClean = false;
      this.pendingNotice = null;
      void conv.chat.sendMessage(
        viewing ? { text: question, metadata: { viewing } } : { text: question }
      );
      return true;
    } catch (error) {
      const line = lineForError(error);
      this.set({ line: line === ASK_MOJI_COPY.ERROR ? ASK_MOJI_COPY.SEND_FAILED : line });
      return false;
    } finally {
      this.busyRequest = false;
      if (!this.disposed) this.set({ working: false });
    }
  }

  // ─── New conversation ─────────────────────────────────────────────────────

  /** End this conversation and open a new one (atomic across devices on the server). */
  async newConversation() {
    if (this.busyRequest || this.isAnswering() || this.disposed) return;
    const current = this.conv;
    this.busyRequest = true;
    this.set({ working: true, line: null, restore: null });
    try {
      const opened = current
        ? await this.api.newConversation({
            conversationId: current.id,
            viewAs: this.viewAs,
            browserTimeZone: this.zone(),
          })
        : await this.api.start({ viewAs: this.viewAs, browserTimeZone: this.zone() });
      if (!this.disposed) this.install(opened);
    } catch (error) {
      if (!this.disposed) {
        if (error instanceof AskMojiApiError && error.code && UNAVAILABLE_CODES.has(error.code)) {
          this.set({ phase: 'unavailable', line: error.line, staffLine: error.staffLine });
        } else {
          this.set({ line: lineForError(error) });
        }
      }
    } finally {
      this.busyRequest = false;
      if (!this.disposed) this.set({ working: false });
      this.updatePolling();
    }
  }

  // ─── Ratings ──────────────────────────────────────────────────────────────

  /** Set (or with null, clear) the rating of an answer: optimistic, rolled back on failure. */
  async rate(uiMessageId: string, rating: AskMojiRating | null) {
    const conv = this.conv;
    if (!conv) return;
    const previous = this.snapshot.ratings[uiMessageId] ?? null;
    if (previous === rating) return;
    const seq = (this.rateSeq.get(uiMessageId) ?? 0) + 1;
    this.rateSeq.set(uiMessageId, seq);
    this.setRating(uiMessageId, rating);
    try {
      const result = await this.api.feedback({ conversationId: conv.id, uiMessageId, rating });
      if (this.conv === conv && this.rateSeq.get(uiMessageId) === seq) {
        this.setRating(uiMessageId, result.rating);
      }
    } catch {
      if (this.conv === conv && this.rateSeq.get(uiMessageId) === seq) {
        this.setRating(uiMessageId, previous);
      }
    }
  }

  private setRating(id: string, rating: AskMojiRating | null) {
    const ratings = { ...this.snapshot.ratings };
    if (rating) ratings[id] = rating;
    else delete ratings[id];
    this.set({ ratings });
  }

  /** Forget a line the user has read (they started typing). The busy hint stays while it holds. */
  clearLine() {
    if (this.snapshot.line && this.snapshot.line !== ASK_MOJI_COPY.BUSY_ELSEWHERE) {
      this.set({ line: null });
    }
  }
}

const lastUserMessage = (messages: readonly AskMojiUIMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i];
  }
  return undefined;
};
