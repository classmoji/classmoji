/**
 * Admission: the one place every turn and every action passes before
 * anything is written or generated (the storage's `loadContext`).
 *
 * In order:
 * 1. The raw trigger is checked against an allowlist: an `action` with no
 *    message, or a `submit-message` with exactly one incoming message.
 *    Everything else (regenerate, an empty submit, unknown triggers) is
 *    refused.
 * 2. The message must be the student's: role `user`, exactly one non-empty
 *    text part and nothing else, length-capped, with a well-formed id.
 * 3. The services revalidate the attempt and its owner under a row lock,
 *    insert the user row (with the hidden per-turn status part), append
 *    `input_admitted` and set a fresh turn fence, in one transaction. A
 *    re-delivered message (same id, same text) gets a fresh fence and no new
 *    row; the same id with other text is refused.
 * 4. The canonical history is returned from Neon, the admitted message
 *    included; the runtime uses it as the conversation.
 *
 * `previousMessages` is never read: the runtime's accumulator can hold a
 * message this boundary refused.
 *
 * The admission (fence, message id, button action) is kept in process for
 * the turn's `run()`, which reads it instead of the database so a superseded
 * run can never pick up a newer run's fence.
 */
import type { UIMessage } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';
import type { TurnAdmission } from './context.ts';
import { QuizTurnError, isRefusal, logDiagnostic, refusalError, type DiagnosticLog } from '../shared/sanitize.ts';

/** The same limits the services apply (quizChat.service.ts). */
export const MAX_MESSAGE_CHARS = 10_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type Classified =
  | { kind: 'action' }
  | { kind: 'message'; message: { id: string; text: string } }
  | { kind: 'refuse'; code: 'invalid_trigger' | 'invalid_input' };

/** Step 1 and 2: decide what an incoming record is, from its raw values only. */
export function classifyIncoming(event: {
  trigger: unknown;
  incomingMessages?: readonly UIMessage[] | null;
}): Classified {
  const incoming = Array.isArray(event.incomingMessages) ? event.incomingMessages : [];
  if (event.trigger === 'action') {
    return incoming.length === 0 ? { kind: 'action' } : { kind: 'refuse', code: 'invalid_input' };
  }
  if (event.trigger !== 'submit-message') return { kind: 'refuse', code: 'invalid_trigger' };
  if (incoming.length !== 1) return { kind: 'refuse', code: 'invalid_input' };

  const message = incoming[0] as UIMessage | undefined;
  if (!message || message.role !== 'user') return { kind: 'refuse', code: 'invalid_input' };
  if (typeof message.id !== 'string' || !MESSAGE_ID.test(message.id)) {
    return { kind: 'refuse', code: 'invalid_input' };
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length !== 1) return { kind: 'refuse', code: 'invalid_input' };
  const part = parts[0] as { type?: unknown; text?: unknown };
  if (part.type !== 'text' || typeof part.text !== 'string') {
    return { kind: 'refuse', code: 'invalid_input' };
  }
  const text = part.text;
  if (text.trim() === '' || text.length > MAX_MESSAGE_CHARS) {
    return { kind: 'refuse', code: 'invalid_input' };
  }
  return { kind: 'message', message: { id: message.id, text } };
}

/** The services admission calls (ClassmojiService.quizChat). */
export type AdmissionDeps = {
  admitStudentMessage: (i: {
    attemptId: string;
    message: { id: string; text: string };
    runId: string;
  }) => Promise<{
    status: 'admitted' | 'redelivered';
    fence: string;
    inputMessageId: string;
    action?: 'next' | 'try_again';
  }>;
  admitAction: (i: { attemptId: string; runId: string }) => Promise<{ fence: string }>;
  loadCanonicalMessages: (attemptId: string) => Promise<QuizUIMessage[]>;
  recordTurnRefused: (attemptId: string, code: string, runId: string) => Promise<void>;
  /** Called for a permanent refusal (the agent closes the session). */
  onPermanentRefusal?: () => void;
  log?: DiagnosticLog;
};

const admissions = new Map<string, TurnAdmission>();

/** The admission `loadContext` made for this chat's current turn, if any. */
export function currentAdmission(chatId: string): TurnAdmission | undefined {
  return admissions.get(chatId);
}

/** Test seam. */
export function clearAdmissions(): void {
  admissions.clear();
}

async function refuse(
  chatId: string,
  runId: string,
  code: string,
  kind: 'temporary' | 'permanent',
  deps: AdmissionDeps
): Promise<never> {
  try {
    await deps.recordTurnRefused(chatId, code, runId);
  } catch (error) {
    logDiagnostic('recordTurnRefused', error, { chatId, runId }, deps.log);
  }
  if (kind === 'permanent') {
    try {
      deps.onPermanentRefusal?.();
    } catch (error) {
      logDiagnostic('onPermanentRefusal', error, { chatId, runId }, deps.log);
    }
  }
  throw refusalError(kind, code);
}

/**
 * Run admission for one `loadContext` call and return the canonical history.
 * Throws a `QuizTurnError` (fixed copy) on every refusal and failure.
 */
export async function admitTurn(
  chatId: string,
  event: { trigger: unknown; incomingMessages?: readonly UIMessage[] | null },
  runId: string,
  deps: AdmissionDeps
): Promise<QuizUIMessage[]> {
  admissions.delete(chatId);
  const classified = classifyIncoming(event);
  if (classified.kind === 'refuse') {
    return refuse(chatId, runId, classified.code, 'temporary', deps);
  }

  try {
    if (classified.kind === 'action') {
      const { fence } = await deps.admitAction({ attemptId: chatId, runId });
      admissions.set(chatId, { fence, inputMessageId: null, runId });
    } else {
      const admitted = await deps.admitStudentMessage({
        attemptId: chatId,
        message: classified.message,
        runId,
      });
      admissions.set(chatId, {
        fence: admitted.fence,
        inputMessageId: admitted.inputMessageId,
        runId,
        ...(admitted.action ? { action: admitted.action } : {}),
      });
    }
  } catch (error) {
    if (isRefusal(error)) {
      // The services refuse under the row lock and leave the journal row to the caller.
      logDiagnostic('admission', error, { chatId, runId }, deps.log);
      return refuse(chatId, runId, error.code, error.kind, deps);
    }
    if (error instanceof QuizTurnError) throw error;
    logDiagnostic('admission', error, { chatId, runId }, deps.log);
    throw new QuizTurnError('reply_failed');
  }

  try {
    return await deps.loadCanonicalMessages(chatId);
  } catch (error) {
    admissions.delete(chatId);
    logDiagnostic('loadCanonicalMessages', error, { chatId, runId }, deps.log);
    throw new QuizTurnError('reply_failed');
  }
}
