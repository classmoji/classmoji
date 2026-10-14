/**
 * Admission: the one place every turn and every action passes before
 * anything is written or generated (the storage's `loadContext`).
 *
 * In order:
 * 1. The raw trigger is checked against an allowlist: an `action` with no
 *    message, or a `submit-message` with exactly one incoming message.
 *    Everything else (regenerate, an empty submit, unknown triggers) is
 *    refused.
 * 2. The message must be the student's: role `user`, with a well-formed id,
 *    and exactly one part and nothing else: a non-empty, length-capped text
 *    part, or a code submission (`data-code-submission`, sandbox questions)
 *    whose data is a submission's shape and nothing more
 *    (`CodeSubmissionInputSchema`).
 * 3. The services revalidate the attempt and its owner under a row lock,
 *    insert the user row (with the hidden per-turn status part; a submission
 *    also with the hidden text the model reads for it), append
 *    `input_admitted` and set a fresh turn fence, in one transaction. A
 *    re-delivered message (same id, same text or the same submission) gets a
 *    fresh fence and no new row; the same id with other content is refused.
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
import {
  CodeSubmissionInputSchema,
  MAX_MESSAGE_CHARS,
  type CodeSubmissionInput,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import type { TurnAdmission } from './context.ts';
import { QuizTurnError, isRefusal, logDiagnostic, refusalError, type DiagnosticLog } from '../shared/sanitize.ts';

/**
 * The longest typed message: the one copy the services read too
 * (@classmoji/utils/quiz-agent, `MAX_STUDENT_MESSAGE_CHARS` in quizChat.service).
 */
export { MAX_MESSAGE_CHARS };
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A student message admission passes on: typed text, or a code submission. */
export type IncomingMessage =
  | { id: string; text: string }
  | { id: string; submission: CodeSubmissionInput };

export type Classified =
  | { kind: 'action' }
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'refuse'; code: 'invalid_trigger' | 'invalid_input' | 'invalid_submission' };

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
  const part = parts[0] as { type?: unknown; text?: unknown; data?: unknown };
  // A code submission: its own refusal (`invalid_submission`, the copy the
  // chat shows for code it could not submit) when it is not a submission's
  // shape. The services check it again, with everything else it must be.
  if (part.type === 'data-code-submission') {
    const parsed = CodeSubmissionInputSchema.safeParse(part.data);
    return parsed.success
      ? { kind: 'message', message: { id: message.id, submission: parsed.data } }
      : { kind: 'refuse', code: 'invalid_submission' };
  }
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
    message: IncomingMessage;
    runId: string;
  }) => Promise<{
    status: 'admitted' | 'redelivered';
    fence: string;
    inputMessageId: string;
    action?: 'next' | 'try_again';
    /** The messages the attempt admits after this one (the journal's count). */
    messagesLeft?: number;
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
        ...(typeof admitted.messagesLeft === 'number'
          ? { messagesLeft: admitted.messagesLeft }
          : {}),
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
