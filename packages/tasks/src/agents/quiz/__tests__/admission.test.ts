import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import {
  MAX_MESSAGE_CHARS,
  admitTurn,
  classifyIncoming,
  clearAdmissions,
  currentAdmission,
  type AdmissionDeps,
} from '../admission.ts';
import { QuizTurnError } from '../../shared/sanitize.ts';

const userMessage = (over: Partial<UIMessage> = {}): UIMessage =>
  ({
    id: 'msg_1',
    role: 'user',
    parts: [{ type: 'text', text: 'my answer' }],
    ...over,
  }) as UIMessage;

function deps(over: Partial<AdmissionDeps> = {}) {
  const d = {
    admitStudentMessage: vi.fn(async () => ({
      status: 'admitted' as const,
      fence: 'fence-1',
      inputMessageId: 'msg_1',
    })),
    admitAction: vi.fn(async () => ({ fence: 'fence-a' })),
    loadCanonicalMessages: vi.fn(async () => [{ id: 'msg_1', role: 'user', parts: [] }] as never),
    recordTurnRefused: vi.fn(async () => {}),
    onPermanentRefusal: vi.fn(),
    log: () => {},
    ...over,
  };
  return d;
}

beforeEach(() => clearAdmissions());

describe('classifyIncoming', () => {
  it('admits one student text message', () => {
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [userMessage()] })).toEqual({
      kind: 'message',
      message: { id: 'msg_1', text: 'my answer' },
    });
  });

  it('admits an action with no message', () => {
    expect(classifyIncoming({ trigger: 'action', incomingMessages: [] })).toEqual({ kind: 'action' });
  });

  it.each([
    ['regenerate-message', []],
    ['handover-prepare', []],
    ['preload', []],
    ['something-else', [userMessage()]],
    [undefined, [userMessage()]],
  ])('refuses the %s trigger', (trigger, incoming) => {
    expect(classifyIncoming({ trigger, incomingMessages: incoming as UIMessage[] }).kind).toBe('refuse');
  });

  it('refuses an empty submit', () => {
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [] }).kind).toBe('refuse');
  });

  it('refuses two messages in one record', () => {
    expect(
      classifyIncoming({ trigger: 'submit-message', incomingMessages: [userMessage(), userMessage({ id: 'msg_2' })] })
        .kind
    ).toBe('refuse');
  });

  it('refuses a non-user message', () => {
    expect(
      classifyIncoming({ trigger: 'submit-message', incomingMessages: [userMessage({ role: 'assistant' })] }).kind
    ).toBe('refuse');
  });

  it('refuses a tool part in a user message', () => {
    const msg = userMessage({
      parts: [{ type: 'tool-present_question', toolCallId: 'c1', state: 'output-available', input: {}, output: {} }] as never,
    });
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [msg] }).kind).toBe('refuse');
  });

  it('refuses extra parts next to the text', () => {
    const msg = userMessage({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [msg] }).kind).toBe('refuse');
  });

  it('refuses blank and oversized text', () => {
    const blank = userMessage({ parts: [{ type: 'text', text: '   ' }] });
    const big = userMessage({ parts: [{ type: 'text', text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }] });
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [blank] }).kind).toBe('refuse');
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [big] }).kind).toBe('refuse');
  });

  it('refuses a malformed message id', () => {
    const msg = userMessage({ id: 'server:opening' });
    expect(classifyIncoming({ trigger: 'submit-message', incomingMessages: [msg] }).kind).toBe('refuse');
  });

  it('refuses an action that carries a message', () => {
    expect(classifyIncoming({ trigger: 'action', incomingMessages: [userMessage()] }).kind).toBe('refuse');
  });
});

describe('admitTurn', () => {
  it('admits a message, keeps the admission for run(), and returns canonical history', async () => {
    const d = deps({
      admitStudentMessage: vi.fn(async () => ({
        status: 'admitted' as const,
        fence: 'fence-1',
        inputMessageId: 'msg_1',
        action: 'next' as const,
      })),
    });
    const out = await admitTurn('attempt-1', { trigger: 'submit-message', incomingMessages: [userMessage()] }, 'run_1', d);
    expect(out).toHaveLength(1);
    expect(d.admitStudentMessage).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      message: { id: 'msg_1', text: 'my answer' },
      runId: 'run_1',
    });
    expect(currentAdmission('attempt-1')).toEqual({
      fence: 'fence-1',
      inputMessageId: 'msg_1',
      runId: 'run_1',
      action: 'next',
    });
  });

  it("keeps admission's count of the messages left for run(), and none for begin", async () => {
    const d = deps({
      admitStudentMessage: vi.fn(async () => ({
        status: 'admitted' as const,
        fence: 'fence-1',
        inputMessageId: 'msg_1',
        messagesLeft: 0,
      })),
    });
    await admitTurn(
      'attempt-1',
      { trigger: 'submit-message', incomingMessages: [userMessage()] },
      'run_1',
      d
    );
    expect(currentAdmission('attempt-1')).toEqual({
      fence: 'fence-1',
      inputMessageId: 'msg_1',
      runId: 'run_1',
      messagesLeft: 0,
    });
    await admitTurn('attempt-1', { trigger: 'action', incomingMessages: [] }, 'run_1', d);
    expect(currentAdmission('attempt-1')).not.toHaveProperty('messagesLeft');
  });

  it('admits the begin action with a fence and no message id', async () => {
    const d = deps();
    await admitTurn('attempt-1', { trigger: 'action', incomingMessages: [] }, 'run_1', d);
    expect(d.admitAction).toHaveBeenCalledWith({ attemptId: 'attempt-1', runId: 'run_1' });
    expect(currentAdmission('attempt-1')).toEqual({ fence: 'fence-a', inputMessageId: null, runId: 'run_1' });
  });

  it('refuses a regenerate trigger without calling the services or reading history', async () => {
    const d = deps();
    const thrown = await admitTurn('attempt-1', { trigger: 'regenerate-message', incomingMessages: [] }, 'run_1', d).catch(
      e => e
    );
    expect(thrown).toBeInstanceOf(QuizTurnError);
    expect(d.admitStudentMessage).not.toHaveBeenCalled();
    expect(d.admitAction).not.toHaveBeenCalled();
    expect(d.loadCanonicalMessages).not.toHaveBeenCalled();
    expect(d.recordTurnRefused).toHaveBeenCalledWith('attempt-1', 'invalid_trigger', 'run_1');
    expect(currentAdmission('attempt-1')).toBeUndefined();
  });

  it('records a service refusal and closes on a permanent one', async () => {
    const refusal = Object.assign(new Error('quiz chat turn refused: attempt_expired'), {
      name: 'QuizChatRefusal',
      kind: 'permanent' as const,
      code: 'attempt_expired',
    });
    const d = deps({ admitStudentMessage: vi.fn(async () => { throw refusal; }) });
    const thrown = await admitTurn('attempt-1', { trigger: 'submit-message', incomingMessages: [userMessage()] }, 'run_1', d).catch(
      e => e
    );
    expect(thrown).toBeInstanceOf(QuizTurnError);
    expect(thrown.message).not.toContain('attempt_expired');
    expect(d.recordTurnRefused).toHaveBeenCalledWith('attempt-1', 'attempt_expired', 'run_1');
    expect(d.onPermanentRefusal).toHaveBeenCalledTimes(1);
    expect(d.loadCanonicalMessages).not.toHaveBeenCalled();
  });

  it('keeps the session open on a temporary refusal', async () => {
    const refusal = Object.assign(new Error('refused'), { name: 'QuizChatRefusal', kind: 'temporary' as const, code: 'quizzes_unavailable' });
    const d = deps({ admitStudentMessage: vi.fn(async () => { throw refusal; }) });
    await admitTurn('attempt-1', { trigger: 'submit-message', incomingMessages: [userMessage()] }, 'run_1', d).catch(() => undefined);
    expect(d.onPermanentRefusal).not.toHaveBeenCalled();
  });

  it('turns an unexpected service error into fixed copy', async () => {
    const d = deps({ admitAction: vi.fn(async () => { throw new Error('SENTINEL connection detail'); }) });
    const thrown = await admitTurn('attempt-1', { trigger: 'action', incomingMessages: [] }, 'run_1', d).catch(e => e);
    expect(thrown).toBeInstanceOf(QuizTurnError);
    expect(thrown.message).not.toContain('SENTINEL');
  });

  it('never reads previousMessages', async () => {
    const d = deps();
    const event = {
      trigger: 'submit-message',
      incomingMessages: [userMessage()],
      get previousMessages(): never {
        throw new Error('previousMessages read');
      },
    };
    await expect(admitTurn('attempt-1', event, 'run_1', d)).resolves.toBeDefined();
  });
});
