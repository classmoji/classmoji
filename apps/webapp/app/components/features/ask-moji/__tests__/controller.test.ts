import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from '@ai-sdk/react';
import { ASK_MOJI_COPY, STATE_POLL_MS, type AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import { AskMojiApiError } from '../api';
import { AskMojiController } from '../controller';
import {
  FakeTransport,
  answerMsg,
  fakeApi,
  flush,
  openedFor,
  pushable,
  reply,
  stateOf,
  streamOf,
  userMsg,
} from './fakes';

/**
 * The panel's state machine (R13) against a scripted transport and API, with
 * the real AI SDK Chat in between.
 */

let api: ReturnType<typeof fakeApi>;
let transport: FakeTransport;
let chats: Chat<AskMojiUIMessage>[];

const make = (over: Partial<ConstructorParameters<typeof AskMojiController>[0]> = {}) =>
  new AskMojiController({
    api,
    transport,
    viewAs: 'STUDENT',
    browserTimeZone: () => 'America/New_York',
    pollMs: 1_000_000,
    createChat: init => {
      const chat = new Chat<AskMojiUIMessage>(init);
      vi.spyOn(chat, 'stop');
      chats.push(chat);
      return chat;
    },
    ...over,
  });

const openReady = async (c: AskMojiController) => {
  c.open();
  await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('ready'));
  return c.getSnapshot().chat!;
};

beforeEach(() => {
  api = fakeApi();
  transport = new FakeTransport();
  chats = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('open', () => {
  it('starts, sets the session when the server has one, and seeds the Chat with the transcript', async () => {
    const transcript = [userMsg('u0', 'Q0'), answerMsg('a0', 'A0')];
    api.start.mockResolvedValue(
      openedFor('c1', {
        transcript,
        state: { status: 'ACTIVE', lastMessageId: 'a0', inFlight: false },
      })
    );
    const c = make();
    const chat = await openReady(c);
    expect(api.start).toHaveBeenCalledWith({
      viewAs: 'STUDENT',
      browserTimeZone: 'America/New_York',
    });
    expect(transport.setSessionCalls).toEqual([
      ['c1', { publicAccessToken: 'tok-c1', lastEventId: '10', isStreaming: false }],
    ]);
    expect(chat.messages.map(m => m.id)).toEqual(['u0', 'a0']);
    expect(transport.reconnects).toHaveLength(0);
  });

  it('without a Trigger session: no setSession; composer focus preloads (startSession → ensure-session)', async () => {
    api.start.mockResolvedValue(openedFor('c1', { sessionReady: false, resumeCursor: '7' }));
    const c = make();
    await openReady(c);
    expect(transport.setSessionCalls).toHaveLength(0);
    // A cursor another device left is held for the session the transport will create.
    expect(transport.seeds).toEqual([['c1', '7']]);
    c.preload();
    expect(transport.preload).toHaveBeenCalledWith('c1');
    c.preload();
    expect(transport.preload).toHaveBeenCalledTimes(1);
  });

  it('a turn in flight at open is joined from the resume cursor', async () => {
    api.start.mockResolvedValue(
      openedFor('c1', {
        transcript: [userMsg('u1', 'Q1')],
        state: { status: 'ACTIVE', lastMessageId: 'u1', inFlight: true },
        resumeCursor: '42',
      })
    );
    const live = pushable();
    transport.reconnectQueue.push(() => live.stream);
    const c = make();
    const chat = await openReady(c);
    await vi.waitFor(() => expect(transport.reconnects).toHaveLength(1));
    expect(transport.sessions.get('c1')).toMatchObject({ lastEventId: '42', isStreaming: true });
    expect(c.getSnapshot().busyElsewhere).toBe(true);
    expect(c.isAnswering()).toBe(true);
    live.push(...reply('a1', 'Live answer'));
    live.close();
    await vi.waitFor(() => expect(chat.messages.map(m => m.id)).toEqual(['u1', 'a1']));
  });

  it('a refused start shows the line; OWNER/TEACHER copy only when the server sent it', async () => {
    api.start.mockRejectedValue(
      new AskMojiApiError({
        code: 'UNAVAILABLE',
        status: 403,
        line: ASK_MOJI_COPY.UNAVAILABLE,
        staffLine: 'Ask Moji needs a Pro subscription.',
      })
    );
    const c = make();
    c.open();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('unavailable'));
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.UNAVAILABLE);
    expect(c.getSnapshot().staffLine).toBe('Ask Moji needs a Pro subscription.');
  });

  it('a failed start can be retried', async () => {
    api.start.mockRejectedValueOnce(new Error('boom'));
    const c = make();
    c.open();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('failed'));
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.INIT_FAILED);
    c.retry();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('ready'));
  });
});

describe('poll', () => {
  it('runs every STATE_POLL_MS while open and visible, stops on close, and catches up on visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const c = make({ pollMs: STATE_POLL_MS });
    await openReady(c);
    const before = api.state.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(STATE_POLL_MS);
      await flush();
    }
    expect(api.state.mock.calls.length).toBe(before + 3);

    c.setVisible(false);
    const hidden = api.state.mock.calls.length;
    vi.advanceTimersByTime(STATE_POLL_MS * 3);
    await flush();
    expect(api.state.mock.calls.length).toBe(hidden);

    c.setVisible(true);
    await flush();
    expect(api.state.mock.calls.length).toBe(hidden + 1);

    c.close();
    const closed = api.state.mock.calls.length;
    vi.advanceTimersByTime(STATE_POLL_MS * 3);
    await flush();
    expect(api.state.mock.calls.length).toBe(closed);
  });

  it('acts only while the Chat is idle', async () => {
    const c = make();
    const chat = await openReady(c);
    const live = pushable();
    transport.sendQueue.push(() => live.stream);
    expect(await c.send('Q1', null)).toBe(true);
    await vi.waitFor(() => expect(chat.status).not.toBe('ready'));
    const calls = api.state.mock.calls.length;
    await c.sync();
    expect(api.state.mock.calls.length).toBe(calls);
    live.push(...reply('a1', 'A1'));
    live.close();
    await vi.waitFor(() => expect(chat.status).toBe('ready'));
  });

  it('adopts a newer transcript and re-seeds the cursor past it', async () => {
    const c = make();
    const chat = await openReady(c);
    api.state.mockResolvedValue(
      stateOf({
        lastMessageId: 'a1',
        resumeCursor: '55',
        transcript: [userMsg('u1', 'From another tab'), answerMsg('a1', 'Answer')],
      })
    );
    await c.sync();
    expect(chat.messages.map(m => m.id)).toEqual(['u1', 'a1']);
    expect(transport.sessions.get('c1')).toMatchObject({ lastEventId: '55', isStreaming: false });
    expect(api.state).toHaveBeenLastCalledWith({ conversationId: 'c1', knownLastMessageId: null });
    await c.sync();
    expect(api.state).toHaveBeenLastCalledWith({ conversationId: 'c1', knownLastMessageId: 'a1' });
  });

  it('joins a turn running elsewhere', async () => {
    const c = make();
    const chat = await openReady(c);
    api.state.mockResolvedValue(
      stateOf({
        lastMessageId: 'u1',
        inFlight: true,
        resumeCursor: '20',
        transcript: [userMsg('u1', 'Q')],
      })
    );
    transport.reconnectQueue.push(() => streamOf(reply('a1', 'Joined')));
    await c.sync();
    expect(c.getSnapshot().busyElsewhere).toBe(true);
    expect(transport.sessions.get('c1')).toMatchObject({ lastEventId: '20', isStreaming: true });
    await vi.waitFor(() => expect(chat.messages.map(m => m.id)).toEqual(['u1', 'a1']));
  });

  it('a conversation ended elsewhere with a replacement: moves to it without stopping the old Chat', async () => {
    const c = make();
    const old = await openReady(c);
    api.state.mockResolvedValue(stateOf({ status: 'COMPLETED', conversationId: 'c2' }));
    api.start.mockResolvedValue(openedFor('c2'));
    await c.sync();
    await vi.waitFor(() => expect(c.getSnapshot().conversationId).toBe('c2'));
    expect(c.getSnapshot().chat).not.toBe(old);
    expect(old.stop).not.toHaveBeenCalled();
  });

  it('ended with nothing after it: says so and never creates one from a poll', async () => {
    const c = make();
    await openReady(c);
    api.state.mockResolvedValue(stateOf({ status: 'COMPLETED', conversationId: null }));
    await c.sync();
    expect(c.getSnapshot().phase).toBe('ended');
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.CONVERSATION_ENDED);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.newConversation).not.toHaveBeenCalled();
  });

  it('a conversation that is no longer the caller’s ends the panel', async () => {
    const c = make();
    await openReady(c);
    api.state.mockResolvedValue(null);
    await c.sync();
    expect(c.getSnapshot().phase).toBe('ended');
  });
});

describe('send', () => {
  it('checks state first; the viewing rides on the message, never on request metadata', async () => {
    const c = make();
    await openReady(c);
    transport.sendQueue.push(() => streamOf(reply('a1', 'A1')));
    const viewing = { kind: 'page' as const, id: 'p1' };
    expect(await c.send('  What is this?  ', viewing)).toBe(true);
    expect(api.state).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    const sent = transport.sends[0];
    const last = sent.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.metadata).toEqual({ viewing });
    expect(last.parts).toEqual([{ type: 'text', text: 'What is this?' }]);
    expect(sent.metadata).toBeUndefined();
    expect(sent.body).toBeUndefined();
  });

  it('a turn in flight elsewhere: BUSY_ELSEWHERE, nothing sent, the turn is joined', async () => {
    const c = make();
    const chat = await openReady(c);
    api.state.mockResolvedValue(
      stateOf({ inFlight: true, lastMessageId: 'u9', transcript: [userMsg('u9', 'Other tab')] })
    );
    transport.reconnectQueue.push(() => streamOf(reply('a9', 'Other answer')));
    expect(await c.send('Mine', null)).toBe(false);
    expect(transport.sends).toHaveLength(0);
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.BUSY_ELSEWHERE);
    await vi.waitFor(() => expect(chat.messages.map(m => m.id)).toEqual(['u9', 'a9']));
  });

  it('is refused while this tab is answering', async () => {
    const c = make();
    await openReady(c);
    const live = pushable();
    transport.sendQueue.push(() => live.stream);
    expect(await c.send('Q1', null)).toBe(true);
    expect(await c.send('Q2', null)).toBe(false);
    live.push(...reply('a1', 'A1'));
    live.close();
  });

  it('refuses empty and over-long questions without asking the server', async () => {
    const c = make();
    await openReady(c);
    const calls = api.state.mock.calls.length;
    expect(await c.send('   ', null)).toBe(false);
    expect(await c.send('x'.repeat(4001), null)).toBe(false);
    expect(api.state.mock.calls.length).toBe(calls);
  });
});

describe('turn end', () => {
  it('replaces the messages with the server transcript once it has the reply', async () => {
    const c = make();
    const chat = await openReady(c);
    transport.sendQueue.push(() => streamOf(reply('a1', 'streamed')));
    api.state.mockResolvedValueOnce(stateOf()); // the check before sending
    api.state.mockResolvedValue(
      stateOf({
        lastMessageId: 'a1',
        transcript: [userMsg(chat.messages[0]?.id ?? 'u1', 'Q1'), answerMsg('a1', 'stored')],
      })
    );
    await c.send('Q1', null);
    await vi.waitFor(() => {
      const text = chat.messages.at(-1)?.parts[0] as { text?: string } | undefined;
      expect(text?.text).toBe('stored');
    });
  });

  it('keeps the streamed answer while the server has not stored it yet (no replay, no resume)', async () => {
    const c = make();
    const chat = await openReady(c);
    transport.sendQueue.push(() => streamOf(reply('a1', 'streamed')));
    api.state.mockResolvedValueOnce(stateOf());
    let userId = '';
    api.state.mockImplementation(async () => {
      userId = chat.messages.find(m => m.role === 'user')!.id;
      return stateOf({
        lastMessageId: userId,
        inFlight: true,
        transcript: [userMsg(userId, 'Q1')],
      });
    });
    await c.send('Q1', null);
    await vi.waitFor(() => expect(api.state.mock.calls.length).toBeGreaterThanOrEqual(2));
    await flush();
    expect(chat.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(transport.reconnects).toHaveLength(0);
    // Settled: the stored transcript is adopted.
    api.state.mockResolvedValue(
      stateOf({
        lastMessageId: 'a1',
        transcript: [userMsg(userId, 'Q1'), answerMsg('a1', 'stored')],
      })
    );
    await c.sync();
    expect((chat.messages[1].parts[0] as { text: string }).text).toBe('stored');
  });

  it('a notice shows its line and puts the question back', async () => {
    const c = make();
    const chat = await openReady(c);
    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'n1' },
        { type: 'data-notice', data: { code: 'PACE' } } as never,
        { type: 'finish' },
      ])
    );
    api.state.mockResolvedValueOnce(stateOf());
    api.state.mockResolvedValue(stateOf({ lastMessageId: null, transcript: [] }));
    await c.send('Too fast', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.PACE));
    expect(c.getSnapshot().restore?.text).toBe('Too fast');
    await vi.waitFor(() => expect(chat.messages).toHaveLength(0));
  });

  it('an error shows only allow-listed copy', async () => {
    const c = make();
    await openReady(c);
    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'e1' },
        { type: 'error', errorText: 'postgres://secret@host failed' },
      ])
    );
    api.state.mockResolvedValue(stateOf());
    await c.send('Q', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.ERROR));

    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'e2' },
        { type: 'error', errorText: ASK_MOJI_COPY.MCP_UNAVAILABLE },
      ])
    );
    await vi.waitFor(() => expect(c.getSnapshot().chat!.status).toBe('ready'));
    await c.send('Q again', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.MCP_UNAVAILABLE));
  });

  it('reports an error that is not copy; allow-listed copy and notices are not reported', async () => {
    const onUnexpectedError = vi.fn();
    const c = make({ onUnexpectedError });
    await openReady(c);
    api.state.mockResolvedValue(stateOf());

    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'u1' },
        { type: 'error', errorText: ASK_MOJI_COPY.MCP_UNAVAILABLE },
      ])
    );
    await c.send('Q', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.MCP_UNAVAILABLE));
    await vi.waitFor(() => expect(c.getSnapshot().chat!.status).toBe('ready'));

    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'u2' },
        { type: 'data-notice', data: { code: 'PACE' } } as never,
        { type: 'finish' },
      ])
    );
    await c.send('Q again', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.PACE));
    await vi.waitFor(() => expect(c.getSnapshot().chat!.status).toBe('ready'));
    expect(onUnexpectedError).not.toHaveBeenCalled();

    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'u3' },
        { type: 'error', errorText: 'Maximum update depth exceeded' },
      ])
    );
    await c.send('Q a third time', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.ERROR));
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
    expect((onUnexpectedError.mock.calls[0][0] as Error).message).toBe(
      'Maximum update depth exceeded'
    );
  });

  it('a reply that goes quiet is released; a turn that settles unanswered says REPLY_FAILED and gives the question back', async () => {
    const c = make({ replyTimings: { startMs: 30, silenceMs: 30 } });
    const chat = await openReady(c);
    const silent = pushable();
    transport.sendQueue.push(() => silent.stream);
    api.state.mockResolvedValueOnce(stateOf());
    api.state.mockImplementation(async () => {
      const u = chat.messages.find(m => m.role === 'user')!;
      return stateOf({ lastMessageId: u.id, inFlight: false, transcript: [u] });
    });
    await c.send('Will it answer?', null);
    await vi.waitFor(() => expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.REPLY_FAILED), {
      timeout: 2000,
    });
    expect(c.getSnapshot().restore?.text).toBe('Will it answer?');
    expect(chat.status).toBe('ready');
  });

  it('a closed session ends the conversation', async () => {
    const c = make();
    await openReady(c);
    transport.sendQueue.push(() => {
      transport.closed.add('c1');
      return streamOf([
        { type: 'start', messageId: 'x1' },
        { type: 'data-notice', data: { code: 'NOT_ALLOWED' } } as never,
        { type: 'finish' },
      ]);
    });
    api.state.mockResolvedValue(stateOf());
    await c.send('Q', null);
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('ended'));
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.NOT_ALLOWED);
  });
});

describe('replay guard: server-confirmed ids', () => {
  it('a send whose stream replays a confirmed reply shows it once', async () => {
    api.start.mockResolvedValue(
      openedFor('c1', {
        transcript: [userMsg('u0', 'Q0'), answerMsg('a0', 'A0')],
        state: { status: 'ACTIVE', lastMessageId: 'a0', inFlight: false },
      })
    );
    const c = make();
    const chat = await openReady(c);
    transport.sendQueue.push(() => streamOf([...reply('a0', 'A0 again'), ...reply('a1', 'A1')]));
    api.state.mockResolvedValue(stateOf({ lastMessageId: 'a0' }));
    await c.send('Q1', null);
    await vi.waitFor(() => expect(chat.status).toBe('ready'));
    await vi.waitFor(() =>
      expect(chat.messages.filter(m => m.role === 'assistant').map(m => m.id)).toEqual(['a0', 'a1'])
    );
    expect((chat.messages[1].parts[0] as { text: string }).text).toBe('A0');
  });
});

describe('New conversation', () => {
  it('waits while an answer is in flight anywhere', async () => {
    const c = make();
    await openReady(c);
    api.state.mockResolvedValue(stateOf({ inFlight: true, transcript: [userMsg('u1', 'Q')] }));
    await c.sync();
    expect(c.isAnswering()).toBe(true);
    await c.newConversation();
    expect(api.newConversation).not.toHaveBeenCalled();
  });

  it('replaces the conversation and swaps the Chat without stopping the old one', async () => {
    const c = make();
    const old = await openReady(c);
    await c.newConversation();
    expect(api.newConversation).toHaveBeenCalledWith({
      conversationId: 'c1',
      viewAs: 'STUDENT',
      browserTimeZone: 'America/New_York',
    });
    expect(c.getSnapshot().conversationId).toBe('c2');
    expect(old.stop).not.toHaveBeenCalled();
  });
});

describe('ratings', () => {
  it('is optimistic and rolls back on failure', async () => {
    const c = make();
    await openReady(c);
    let fail!: (e: unknown) => void;
    api.feedback.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        })
    );
    const pending = c.rate('a1', 'UP');
    expect(c.getSnapshot().ratings).toEqual({ a1: 'UP' });
    fail(new Error('nope'));
    await pending;
    expect(c.getSnapshot().ratings).toEqual({});
  });

  it('toggles and clears through the feedback route; a stale answer is ignored', async () => {
    const c = make();
    await openReady(c);
    await c.rate('a1', 'DOWN');
    expect(api.feedback).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      uiMessageId: 'a1',
      rating: 'DOWN',
    });
    expect(c.getSnapshot().ratings.a1).toBe('DOWN');
    let slow!: (v: { rating: 'UP' | null }) => void;
    api.feedback.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          slow = resolve;
        })
    );
    const first = c.rate('a1', 'UP');
    const second = c.rate('a1', null);
    await second;
    slow({ rating: 'UP' });
    await first;
    expect(c.getSnapshot().ratings.a1).toBeUndefined();
    expect(api.feedback).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      uiMessageId: 'a1',
      rating: null,
    });
  });
});

describe('preload (R14: the first keystroke, never open)', () => {
  it('opening boots nothing; preload starts the session once while it is starting', async () => {
    api.start.mockResolvedValue(openedFor('c1', { sessionReady: false }));
    let finish!: () => void;
    transport.preload.mockImplementation(
      chatId =>
        new Promise<void>(resolve => {
          finish = () => {
            transport.sessions.set(chatId, { publicAccessToken: 'started' });
            resolve();
          };
        })
    );
    const c = make();
    await openReady(c);
    await flush();
    expect(transport.preload).not.toHaveBeenCalled();
    expect(api.ensureSession).not.toHaveBeenCalled();
    c.preload();
    c.preload();
    c.preload();
    expect(transport.preload).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    c.preload();
    expect(transport.preload).toHaveBeenCalledTimes(1);
  });

  it('a failed preload can be tried again by the next keystroke', async () => {
    api.start.mockResolvedValue(openedFor('c1', { sessionReady: false }));
    transport.preload.mockRejectedValueOnce(new Error('down'));
    const c = make();
    await openReady(c);
    c.preload();
    await flush();
    c.preload();
    expect(transport.preload).toHaveBeenCalledTimes(2);
  });
});

describe('start refusals Try again cannot fix', () => {
  const refusal = (code: string, permanent = false) =>
    new AskMojiApiError({
      code,
      status: 403,
      line: (ASK_MOJI_COPY as Record<string, string>)[code] ?? ASK_MOJI_COPY.ERROR,
      permanent,
    });

  it.each(['CLASSROOM_LOCKED', 'CLASSROOM_UNPUBLISHED', 'NOT_ALLOWED'])(
    '%s is unavailable with its fixed line, not failed',
    async code => {
      api.start.mockRejectedValue(refusal(code));
      const c = make();
      c.open();
      await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('unavailable'));
      expect(c.getSnapshot().line).toBe((ASK_MOJI_COPY as Record<string, string>)[code]);
      c.retry();
      expect(api.start).toHaveBeenCalledTimes(1);
    }
  );

  it('any permanent refusal is unavailable; a transient one keeps Try again', async () => {
    api.start.mockRejectedValueOnce(refusal('NOT_FOUND', true));
    const c = make();
    c.open();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('unavailable'));

    api.start.mockRejectedValueOnce(refusal('RATE_LIMITED'));
    const d = make();
    d.open();
    await vi.waitFor(() => expect(d.getSnapshot().phase).toBe('failed'));
    expect(d.getSnapshot().line).toBe(ASK_MOJI_COPY.RATE_LIMITED);
  });

  it('reopening asks again (the class may have been unlocked)', async () => {
    api.start.mockRejectedValueOnce(refusal('CLASSROOM_LOCKED'));
    const c = make();
    c.open();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('unavailable'));
    c.close();
    c.open();
    await vi.waitFor(() => expect(c.getSnapshot().phase).toBe('ready'));
  });

  it('New conversation refused for a locked class is unavailable too', async () => {
    const c = make();
    await openReady(c);
    api.newConversation.mockRejectedValue(refusal('CLASSROOM_LOCKED'));
    await c.newConversation();
    expect(c.getSnapshot().phase).toBe('unavailable');
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.CLASSROOM_LOCKED);
  });
});

describe('a send that cannot go says why', () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('waits for a poll in flight, then sends (Enter never does nothing)', async () => {
    const c = make();
    await openReady(c);
    const poll = deferred<ReturnType<typeof stateOf>>();
    api.state.mockImplementationOnce(() => poll.promise);
    const polling = c.sync();
    transport.sendQueue.push(() => streamOf(reply('a1', 'A1')));
    const sending = c.send('Queued', null);
    await flush();
    expect(c.getSnapshot().working).toBe(true);
    expect(transport.sends).toHaveLength(0);
    poll.resolve(stateOf());
    await polling;
    expect(await sending).toBe(true);
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(c.getSnapshot().working).toBe(false);
  });

  it('the conversation moved while it waited: not sent, SEND_FAILED, the text is the caller’s', async () => {
    const c = make();
    await openReady(c);
    const poll = deferred<ReturnType<typeof stateOf>>();
    api.state.mockImplementationOnce(() => poll.promise);
    api.start.mockResolvedValue(openedFor('c2'));
    const polling = c.sync();
    const sending = c.send('Lost in the move', null);
    poll.resolve(stateOf({ status: 'COMPLETED', conversationId: 'c2' }));
    await polling;
    expect(await sending).toBe(false);
    expect(c.getSnapshot().conversationId).toBe('c2');
    expect(c.getSnapshot().line).toBe(ASK_MOJI_COPY.SEND_FAILED);
    expect(transport.sends).toHaveLength(0);
  });

  it('while this tab is answering: the busy hint, not silence', async () => {
    const c = make();
    await openReady(c);
    const live = pushable();
    transport.sendQueue.push(() => live.stream);
    expect(await c.send('Q1', null)).toBe(true);
    expect(c.getSnapshot().hint).toBeNull();
    expect(await c.send('Q2', null)).toBe(false);
    expect(c.getSnapshot().hint).toBe(ASK_MOJI_COPY.PACE);
    c.clearLine();
    expect(c.getSnapshot().hint).toBeNull();
    c.blocked();
    expect(c.getSnapshot().hint).toBe(ASK_MOJI_COPY.PACE);
    live.push(...reply('a1', 'A1'));
    live.close();
    await vi.waitFor(() => expect(c.getSnapshot().hint).toBeNull());
  });

  it('a second send while one is checking gets the hint', async () => {
    const c = make();
    await openReady(c);
    const check = deferred<ReturnType<typeof stateOf>>();
    api.state.mockImplementationOnce(() => check.promise);
    transport.sendQueue.push(() => streamOf(reply('a1', 'A1')));
    const first = c.send('First', null);
    expect(await c.send('Second', null)).toBe(false);
    expect(c.getSnapshot().hint).toBe(ASK_MOJI_COPY.PACE);
    check.resolve(stateOf());
    expect(await first).toBe(true);
  });
});

describe('BUSY_ELSEWHERE is never this tab’s own turn', () => {
  it('after the watchdog released our reply, the turn still in flight is joined silently', async () => {
    const c = make({ replyTimings: { startMs: 30, silenceMs: 30 } });
    const chat = await openReady(c);
    const silent = pushable();
    transport.sendQueue.push(() => silent.stream);
    api.state.mockResolvedValueOnce(stateOf());
    // Our question is the one in flight on the server.
    api.state.mockImplementation(async () => {
      const u = chat.messages.find(m => m.role === 'user')!;
      return stateOf({ lastMessageId: u.id, inFlight: true, transcript: [u] });
    });
    expect(await c.send('Slow one', null)).toBe(true);
    await vi.waitFor(() => expect(transport.reconnects.length).toBeGreaterThanOrEqual(1), {
      timeout: 2000,
    });
    expect(c.getSnapshot().busyElsewhere).toBe(false);
    await vi.waitFor(() => expect(chat.status).toBe('ready'));
    await flush();
    // Trying again while it still runs: joined, and not called "another window".
    expect(await c.send('Again', null)).toBe(false);
    expect(c.getSnapshot().line).not.toBe(ASK_MOJI_COPY.BUSY_ELSEWHERE);
    expect(c.getSnapshot().busyElsewhere).toBe(false);
  });

  it('a turn another window started after ours is theirs', async () => {
    const c = make({ replyTimings: { startMs: 30, silenceMs: 30 } });
    const chat = await openReady(c);
    transport.sendQueue.push(() => pushable().stream);
    api.state.mockResolvedValueOnce(stateOf());
    api.state.mockImplementation(async () => {
      const u = chat.messages.find(m => m.role === 'user')!;
      return stateOf({
        lastMessageId: 'u-other',
        inFlight: true,
        transcript: [u, answerMsg('a-mine', 'Mine'), userMsg('u-other', 'Theirs')],
      });
    });
    expect(await c.send('Mine', null)).toBe(true);
    await vi.waitFor(() => expect(c.getSnapshot().busyElsewhere).toBe(true), { timeout: 2000 });
  });
});
