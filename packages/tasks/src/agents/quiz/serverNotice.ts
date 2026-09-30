/**
 * The marker line that opens every text the server puts into the model's
 * context in the user role: the per-turn CURRENT STATUS part of a student
 * message, the status sent as its own message when that part is missing, and
 * each SYSTEM NOTICE. The student writes in the same role, so the marker
 * carries a per-attempt token the student never sees: an HMAC of the attempt
 * id under the server's signing secret.
 *
 * Format, one line, then a newline and the text:
 *
 *   [[server-notice:<token>]]
 *
 * `<token>` is 24 lowercase hex characters. The token is never stored and
 * never streamed: it is added to each request, the same bytes every turn of
 * the attempt, so the prompt cache keeps hitting. The per-attempt system
 * block states the marker (`serverNoticeMarker`), and admission refuses
 * student text that uses the reserved words (quizChat.service).
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { ModelMessage } from 'ai';

/** First line of a user-role part the status block starts with. */
const STATUS_HEADING = 'CURRENT STATUS';

let processSecret: string | undefined;

/**
 * The signing secret (`BETTER_AUTH_SECRET`), read when first needed. Without
 * it (tests, a bare local run) a random secret for this process keeps the
 * marker unguessable; it then differs between runs, which only costs cache
 * hits.
 */
function secret(): string {
  const configured = process.env.BETTER_AUTH_SECRET;
  if (configured) return configured;
  processSecret ??= randomBytes(32).toString('hex');
  return processSecret;
}

/** The attempt's token: 24 hex characters. */
export function serverNoticeToken(attemptId: string): string {
  return createHmac('sha256', secret())
    .update(`quiz-server-notice:${attemptId}`)
    .digest('hex')
    .slice(0, 24);
}

/** The attempt's marker line, `[[server-notice:<token>]]`. */
export function serverNoticeMarker(attemptId: string): string {
  return `[[server-notice:${serverNoticeToken(attemptId)}]]`;
}

/** `text` opened by the attempt's marker line. */
export function markServerText(attemptId: string, text: string): string {
  return `${serverNoticeMarker(attemptId)}\n${text}`;
}

/**
 * The history with every stored status part opened by the attempt's marker.
 * A status part is a text part after the first one of a user message that
 * starts with CURRENT STATUS: admission stores a student message as its text
 * followed by the status, and admits only a single text part from the
 * student, so a later text part is always the server's. Messages without one
 * come back as they are.
 */
export function markStatusParts(attemptId: string, messages: ModelMessage[]): ModelMessage[] {
  const marker = serverNoticeMarker(attemptId);
  return messages.map(m => {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    let textParts = 0;
    let changed = false;
    const content = m.content.map(part => {
      if (part.type !== 'text') return part;
      textParts += 1;
      if (textParts === 1 || !part.text.startsWith(STATUS_HEADING)) return part;
      changed = true;
      return { ...part, text: `${marker}\n${part.text}` };
    });
    return changed ? { ...m, content } : m;
  });
}
