import { describe, expect, it } from 'vitest';
import { QUIZ_AGENT_ERROR_COPY } from '@classmoji/utils/quiz-agent';
import { FIXED_COPY, QuizTurnError, refusalError, sanitized, toTurnError } from '../sanitize.ts';

const SENTINEL = 'SENTINEL-8f3a-row-value';

function capture() {
  const lines: string[] = [];
  const log = (line: string, fields: Record<string, unknown>) => {
    lines.push(`${line} ${JSON.stringify(fields)}`);
  };
  return { lines, log };
}

describe('sanitized', () => {
  it('rethrows fixed copy and keeps the original message out of the logs', async () => {
    const { lines, log } = capture();
    const wrapped = sanitized(
      'run',
      async (_e: { chatId: string }) => {
        const error = new Error(`query failed near ${SENTINEL}`) as Error & { code?: string };
        error.code = 'P2002';
        throw error;
      },
      { log }
    );
    const thrown = await wrapped({ chatId: 'attempt-1' }).catch(e => e);
    expect(thrown).toBeInstanceOf(QuizTurnError);
    expect(thrown.message).toBe(FIXED_COPY.reply_failed);
    expect(thrown.message).not.toContain(SENTINEL);
    expect(lines.join('\n')).not.toContain(SENTINEL);
    expect(lines.join('\n')).toContain('P2002');
    expect(lines.join('\n')).toContain('attempt-1');
  });

  it('keeps a stack or cause out of the logs', async () => {
    const { lines, log } = capture();
    const wrapped = sanitized(
      'loadContext',
      async () => {
        throw new Error('outer', { cause: new Error(SENTINEL) });
      },
      { log }
    );
    await wrapped().catch(() => undefined);
    expect(lines.join('\n')).not.toContain(SENTINEL);
  });

  it('passes a QuizTurnError through unchanged', async () => {
    const original = new QuizTurnError('turn_stopped');
    const wrapped = sanitized('run', async () => {
      throw original;
    });
    await expect(wrapped()).rejects.toBe(original);
  });

  it('lets out-of-memory and abort errors reach the runtime unchanged', async () => {
    class OutOfMemoryError extends Error {}
    const oom = new OutOfMemoryError('oom');
    await expect(
      sanitized(
        'run',
        async () => {
          throw oom;
        },
        { log: () => {} }
      )()
    ).rejects.toBe(oom);
    const abort = new DOMException('aborted', 'AbortError');
    await expect(
      sanitized(
        'run',
        async () => {
          throw abort;
        },
        { log: () => {} }
      )()
    ).rejects.toBe(abort);
  });

  it('maps a service refusal to its fixed copy by code', () => {
    const refusal = Object.assign(new Error(`refused ${SENTINEL}`), {
      name: 'QuizChatRefusal',
      kind: 'permanent' as const,
      code: 'attempt_expired',
    });
    const turnError = toTurnError('admission', refusal, {}, { log: () => {} });
    expect(turnError.kind).toBe('refused');
    expect(turnError.refusal).toBe('permanent');
    expect(turnError.code).toBe('attempt_expired');
    expect(turnError.message).not.toContain(SENTINEL);
  });

  it('falls back to copy by kind for an unknown refusal code', () => {
    expect(refusalError('temporary', 'something_new').message).toMatch(/try again later/i);
    expect(refusalError('permanent', 'something_new').message).toMatch(/no longer/i);
  });

  it('never logs an id that is not id-shaped', async () => {
    const { lines, log } = capture();
    const wrapped = sanitized(
      'run',
      async (_e: { chatId: string }) => {
        throw new Error('x');
      },
      { log }
    );
    await wrapped({ chatId: `bad id ${SENTINEL}` }).catch(() => undefined);
    expect(lines.join('\n')).not.toContain(SENTINEL);
  });
});

describe('fixed copy', () => {
  it('sends only lines the chat shows (the shared quiz-agent copy)', () => {
    const allowed = new Set(QUIZ_AGENT_ERROR_COPY);
    for (const kind of Object.keys(FIXED_COPY) as Array<keyof typeof FIXED_COPY>) {
      expect(allowed.has(new QuizTurnError(kind).message)).toBe(true);
    }
    for (const code of [
      'quizzes_unavailable',
      'attempt_completed',
      'attempt_expired',
      'attempt_not_found',
      'wrong_runtime',
      'not_a_member',
      'turn_limit',
      'too_fast',
      'invalid_message',
      'message_conflict',
      'invalid_input',
      'invalid_trigger',
      'already_started',
      'some_new_code',
    ]) {
      for (const kind of ['temporary', 'permanent'] as const) {
        expect(allowed.has(refusalError(kind, code).message)).toBe(true);
      }
    }
  });
});
