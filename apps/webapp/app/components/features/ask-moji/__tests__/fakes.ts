/**
 * Test doubles for the Ask Moji controller: a Trigger transport that records
 * what it is asked and replays scripted reply streams, and an API whose
 * answers each test sets.
 */
import { vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import type { AskMojiApi, AskMojiOpened, AskMojiState } from '../api';
import type { AskMojiSessionTransport } from '../controller';

/** A stream that emits these chunks and closes. */
export const streamOf = (chunks: UIMessageChunk[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** A stream the test feeds by hand. */
export const pushable = () => {
  let ctl!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      ctl = c;
    },
  });
  return {
    stream,
    push: (...chunks: UIMessageChunk[]) => chunks.forEach(c => ctl.enqueue(c)),
    close: () => ctl.close(),
  };
};

/** One whole reply: start, a text, finish. */
export const reply = (messageId: string, text: string): UIMessageChunk[] => [
  { type: 'start', messageId },
  { type: 'text-start', id: `${messageId}-t` },
  { type: 'text-delta', id: `${messageId}-t`, delta: text },
  { type: 'text-end', id: `${messageId}-t` },
  { type: 'finish' },
];

export const userMsg = (id: string, text: string): AskMojiUIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

export const answerMsg = (id: string, text: string): AskMojiUIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

type Session = {
  publicAccessToken: string;
  lastEventId?: string;
  isStreaming?: boolean;
  closed?: boolean;
};

export class FakeTransport implements AskMojiSessionTransport {
  sessions = new Map<string, Session>();
  closed = new Set<string>();
  seeds: [string, string][] = [];
  sends: Parameters<AskMojiSessionTransport['sendMessages']>[0][] = [];
  reconnects: Parameters<AskMojiSessionTransport['reconnectToStream']>[0][] = [];
  sendQueue: (() => ReadableStream<UIMessageChunk>)[] = [];
  reconnectQueue: (() => ReadableStream<UIMessageChunk> | null)[] = [];
  setSessionCalls: [string, Session][] = [];
  preload = vi.fn(async (chatId: string) => {
    this.sessions.set(chatId, { publicAccessToken: 'started' });
  });

  sendMessages: AskMojiSessionTransport['sendMessages'] = async options => {
    this.sends.push(options);
    const next = this.sendQueue.shift();
    if (!next) throw new Error('no scripted reply');
    return next();
  };

  reconnectToStream: AskMojiSessionTransport['reconnectToStream'] = async options => {
    this.reconnects.push(options);
    const next = this.reconnectQueue.shift();
    return next ? next() : null;
  };

  getSession(chatId: string) {
    const s = this.sessions.get(chatId);
    return s ? { ...s, closed: this.closed.has(chatId) } : undefined;
  }

  setSession(chatId: string, session: Session) {
    this.setSessionCalls.push([chatId, { ...session }]);
    this.sessions.set(chatId, { ...session });
  }

  seedResumeCursor(chatId: string, cursor: string) {
    this.seeds.push([chatId, cursor]);
  }

  sessionStatus(chatId: string): 'open' | 'closed' {
    return this.closed.has(chatId) ? 'closed' : 'open';
  }
}

export const openedFor = (
  conversationId: string,
  over: Partial<AskMojiOpened> = {}
): AskMojiOpened => ({
  ok: true,
  conversationId,
  publicAccessToken: `tok-${conversationId}`,
  sessionReady: true,
  resumeCursor: '10',
  transcript: [],
  ratings: {},
  welcome: 'Hi!',
  suggestions: [{ text: 'What is due?', icon: 'calendar' }],
  viewAs: 'STUDENT',
  state: { status: 'ACTIVE', lastMessageId: null, inFlight: false },
  created: false,
  ...over,
});

export const stateOf = (over: Partial<AskMojiState> = {}): AskMojiState => ({
  status: 'ACTIVE',
  conversationId: 'c1',
  lastMessageId: null,
  inFlight: false,
  resumeCursor: '10',
  ...over,
});

export const fakeApi = () => {
  const api = {
    start: vi.fn<AskMojiApi['start']>(async () => openedFor('c1')),
    newConversation: vi.fn<AskMojiApi['newConversation']>(async () => openedFor('c2')),
    ensureSession: vi.fn<AskMojiApi['ensureSession']>(async () => ({ publicAccessToken: 'pat' })),
    token: vi.fn<AskMojiApi['token']>(async () => ({ publicAccessToken: 'fresh' })),
    state: vi.fn<AskMojiApi['state']>(async () => stateOf()),
    end: vi.fn<AskMojiApi['end']>(async () => ({ changed: true })),
    feedback: vi.fn<AskMojiApi['feedback']>(async i => ({ rating: i.rating })),
  };
  return api;
};

/** Let pending promises and zero-delay timers run. */
export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};
