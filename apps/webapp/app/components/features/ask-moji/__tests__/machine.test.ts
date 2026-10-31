import { describe, expect, it, vi } from 'vitest';
import type { ChatTransport, UIMessageChunk } from 'ai';
import {
  ASK_MOJI_COPY,
  ASK_MOJI_ERROR_COPY,
  TURN_DEADLINE_MS,
  type AskMojiUIMessage,
} from '@classmoji/utils/ask-moji';
import {
  ASK_MOJI_REPLY_TIMINGS,
  askMojiChatTransport,
  decideState,
  isEndingCode,
  lineForError,
  lineForNotice,
  wireViewing,
} from '../machine';
import { answerMsg, reply, stateOf, streamOf, userMsg } from './fakes';

const read = async (stream: ReadableStream<UIMessageChunk> | null) => {
  const out: UIMessageChunk[] = [];
  if (!stream) return out;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
};

describe('watchdog timings', () => {
  it('90 s to the first chunk, the turn deadline plus a minute of silence', () => {
    expect(ASK_MOJI_REPLY_TIMINGS).toEqual({
      startMs: 90_000,
      silenceMs: TURN_DEADLINE_MS + 60_000,
    });
  });
});

describe('decideState', () => {
  const base = {
    conversationId: 'c1',
    local: [] as AskMojiUIMessage[],
    confirmedIds: new Set<string>(),
    lastFinishClean: false,
  };

  it('null: ended; another conversation: switch; completed with none: ended-no-next', () => {
    expect(decideState({ ...base, state: null })).toEqual({ type: 'ended' });
    expect(
      decideState({ ...base, state: stateOf({ status: 'COMPLETED', conversationId: 'c2' }) })
    ).toEqual({ type: 'switch', conversationId: 'c2' });
    expect(decideState({ ...base, state: stateOf({ conversationId: 'c9' }) })).toEqual({
      type: 'switch',
      conversationId: 'c9',
    });
    expect(
      decideState({ ...base, state: stateOf({ status: 'COMPLETED', conversationId: null }) })
    ).toEqual({ type: 'ended-no-next' });
  });

  it('adopts a transcript when it came; resumes when in flight', () => {
    const transcript = [userMsg('u1', 'Q')];
    expect(decideState({ ...base, state: stateOf({ transcript }) })).toMatchObject({
      type: 'stay',
      adopt: true,
      resume: false,
    });
    expect(decideState({ ...base, state: stateOf({ inFlight: true, transcript }) })).toMatchObject({
      type: 'stay',
      adopt: true,
      resume: true,
    });
    expect(decideState({ ...base, state: stateOf() })).toMatchObject({
      adopt: false,
      resume: false,
    });
  });

  it('ahead of the server (a clean reply it has not stored): neither adopt nor resume', () => {
    const local = [userMsg('u1', 'Q'), answerMsg('a1', 'A')];
    const state = stateOf({ inFlight: true, transcript: [userMsg('u1', 'Q')] });
    expect(decideState({ ...base, local, state, lastFinishClean: true })).toMatchObject({
      adopt: false,
      resume: false,
      ahead: true,
    });
    // A reply the watchdog released is not "ahead": the stored state wins.
    expect(decideState({ ...base, local, state, lastFinishClean: false })).toMatchObject({
      adopt: true,
      resume: true,
    });
    // Settled: the stored transcript wins.
    expect(
      decideState({
        ...base,
        local,
        lastFinishClean: true,
        state: stateOf({ inFlight: false, transcript: [userMsg('u1', 'Q')] }),
      })
    ).toMatchObject({ adopt: true, resume: false });
  });
});

describe('lines: fixed copy only', () => {
  it('an error shows its text only when it is one of the allow-listed lines', () => {
    expect(lineForError(new Error(ASK_MOJI_COPY.RATE_LIMITED))).toBe(ASK_MOJI_COPY.RATE_LIMITED);
    expect(lineForError(new Error('ECONNREFUSED 10.0.0.3:5432'))).toBe(ASK_MOJI_COPY.ERROR);
    expect(lineForError({ line: ASK_MOJI_COPY.SEND_FAILED })).toBe(ASK_MOJI_COPY.SEND_FAILED);
    expect(lineForError('a string')).toBe(ASK_MOJI_COPY.ERROR);
    for (const line of ASK_MOJI_ERROR_COPY) expect(lineForError(new Error(line))).toBe(line);
  });

  it('a notice code maps to its line; an unknown code to the generic one', () => {
    expect(lineForNotice('MCP_UNAVAILABLE')).toBe(ASK_MOJI_COPY.MCP_UNAVAILABLE);
    expect(lineForNotice('<script>')).toBe(ASK_MOJI_COPY.ERROR);
  });

  it('permanent refusals end the conversation; transient ones do not', () => {
    expect(isEndingCode('NOT_FOUND')).toBe(true);
    expect(isEndingCode('SESSION_ENDED')).toBe(true);
    expect(isEndingCode('PACE')).toBe(false);
    expect(isEndingCode('REPLY_FAILED')).toBe(false);
    expect(isEndingCode('toString')).toBe(false);
  });
});

describe('wireViewing', () => {
  it('keeps kind, id and (for a deck) slide; never the title', () => {
    expect(wireViewing({ kind: 'page', id: 'p1', title: 'Week 1' } as never)).toEqual({
      kind: 'page',
      id: 'p1',
    });
    expect(wireViewing({ kind: 'deck', id: 'd1', slide: 3 })).toEqual({
      kind: 'deck',
      id: 'd1',
      slide: 3,
    });
    expect(wireViewing({ kind: 'page', id: 'p1', slide: 3 })).toEqual({ kind: 'page', id: 'p1' });
    expect(wireViewing({ kind: 'calendar' })).toEqual({ kind: 'calendar' });
  });

  it('drops anything the schema refuses', () => {
    expect(wireViewing({ kind: 'grades', id: 'x' })).toBeNull();
    expect(wireViewing({ kind: 'page', id: 'x'.repeat(200) })).toBeNull();
    expect(wireViewing({ kind: 'deck', id: 'd', slide: -1 })).toBeNull();
    expect(wireViewing(null)).toBeNull();
  });
});

describe('askMojiChatTransport', () => {
  const base = (send: UIMessageChunk[], reconnect: UIMessageChunk[] | null) =>
    ({
      sendMessages: vi.fn(async () => streamOf(send)),
      reconnectToStream: vi.fn(async () => (reconnect ? streamOf(reconnect) : null)),
    }) as unknown as ChatTransport<AskMojiUIMessage>;

  const hooks = (known: string[]) => ({
    knownIds: () => new Set(known),
    onReply: vi.fn(),
    onQuiet: vi.fn(),
  });

  it('drops replies the server confirmed, using its ids, not the messages sent', async () => {
    const t = askMojiChatTransport(
      base([...reply('a0', 'old'), ...reply('a1', 'new')], null),
      hooks(['a0'])
    );
    const chunks = await read(
      await t.sendMessages({
        trigger: 'submit-message',
        chatId: 'c1',
        messageId: undefined,
        // An optimistic id the server never confirmed is NOT a known id.
        messages: [answerMsg('a1', 'optimistic'), userMsg('u2', 'Q')],
        abortSignal: undefined,
      })
    );
    expect(
      chunks.filter(c => c.type === 'start').map(c => (c as { messageId: string }).messageId)
    ).toEqual(['a1']);
  });

  it('a new message starts at its first start; a resume keeps a reply’s middle', async () => {
    const leftover: UIMessageChunk[] = [
      { type: 'text-delta', id: 't0', delta: 'rest of an old reply' },
    ];
    const t = askMojiChatTransport(
      base([...leftover, ...reply('a1', 'x')], [...leftover, { type: 'finish' }]),
      hooks([])
    );
    const sent = await read(
      await t.sendMessages({
        trigger: 'submit-message',
        chatId: 'c1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    );
    expect(sent[0].type).toBe('start');
    const resumed = await read(await t.reconnectToStream({ chatId: 'c1' }));
    expect(resumed[0].type).toBe('text-delta');
  });

  it('notes whether the finish came', async () => {
    const h = hooks([]);
    const t = askMojiChatTransport(base(reply('a1', 'x'), null), h);
    await read(
      await t.sendMessages({
        trigger: 'submit-message',
        chatId: 'c1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
    );
    const sawFinish = h.onReply.mock.calls[0][1] as () => boolean;
    expect(sawFinish()).toBe(true);
    expect(await t.reconnectToStream({ chatId: 'c1' })).toBeNull();
  });
});
