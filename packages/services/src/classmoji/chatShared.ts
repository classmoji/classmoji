/**
 * Pieces every chat agent's conversation storage shares (quizChat.service,
 * askMojiChat.service): stored rows as UIMessages, write ordering, the
 * per-key `ai_conversations.context` write, the message-id rule, the pace,
 * the classroom mutation rule, the chat grant, and the two reads behind the
 * re-delivery rule. Each service keeps its own policy on top of these.
 */
import type { Prisma } from '@prisma/client';
import { MIN_TURN_INTERVAL_MS } from '@classmoji/utils/agents/limits';

export type Tx = Prisma.TransactionClient;

/**
 * The shortest time between two admitted turns of one conversation
 * (@classmoji/utils/agents/limits, one copy for every chat agent).
 */
export { MIN_TURN_INTERVAL_MS };

/** Browser message ids. Server-made ids contain `:` and never match. */
export const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether the classroom's status lets this role take a turn: the webapp's
 * mutation gate, `canMutateClassroom` in packages/auth/src/predicates.ts,
 * restated here because @classmoji/auth depends on this package (a parity
 * test holds the two together). The owner always may; anyone else only while
 * the classroom is ACTIVE (LOCKED and UNPUBLISHED are read-only).
 */
export const classroomAllowsTurn = ({ status, role }: { status: string; role: string }) =>
  role === 'OWNER' || status === 'ACTIVE';

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ─── Stored messages ────────────────────────────────────────────────────────

export type StoredMessageRow = {
  ui_message_id: string | null;
  role: string;
  parts: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
};

/** A stored row as a UIMessage of the caller's type. */
export const toUIMessage = <M>(row: StoredMessageRow): M =>
  ({
    id: row.ui_message_id ?? '',
    role: row.role === 'ASSISTANT' ? 'assistant' : row.role === 'SYSTEM' ? 'system' : 'user',
    parts: Array.isArray(row.parts) ? row.parts : [],
    ...(isObject(row.metadata) ? { metadata: row.metadata } : {}),
  }) as unknown as M;

/**
 * A `created_at` strictly after the conversation's latest row, so the order
 * rows are read back in is the order they were written. Caller holds the
 * lock that serializes every writer of this conversation.
 */
export const nextCreatedAt = async (tx: Tx, conversationId: string): Promise<Date> => {
  const last = await tx.aIConversationMessage.findFirst({
    where: { conversation_id: conversationId },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  return new Date(Math.max(Date.now(), (last?.created_at.getTime() ?? 0) + 1));
};

// ─── ai_conversations.context ───────────────────────────────────────────────

/** The `context` keys written one at a time, each without touching the others. */
export type ContextKey = 'runtime' | 'grant';

/** Replace one key of `ai_conversations.context`, keeping every other key. */
export const writeContextKey = async (
  tx: Tx,
  conversationId: string,
  key: ContextKey,
  value: unknown
): Promise<void> => {
  const json = JSON.stringify(value ?? null);
  await tx.$executeRaw`
    UPDATE ai_conversations
    SET context = jsonb_set(COALESCE(context, '{}'::jsonb), ARRAY[${key}]::text[], ${json}::jsonb, true)
    WHERE id = ${conversationId}`;
};

// ─── The chat grant ─────────────────────────────────────────────────────────

/**
 * Who a chat session was issued to, written by the webapp before the session
 * starts (the quiz's on `quiz_attempts.chat_grant`, Ask Moji's on
 * `ai_conversations.context.grant`). The task re-checks the conversation, the
 * membership and the classroom every turn; this record is what those checks
 * and the audit trail read. `web_session_id` is kept for the audit trail only.
 *
 * The webapp's quiz session route declares the same shape
 * (apps/webapp/app/routes/api.quiz-chat.session/session.server.ts).
 */
export interface ChatGrant {
  actor_user_id: string;
  effective_user_id: string;
  classroom_id: string;
  role: string;
  web_session_id: string | null;
  impersonation: { by: string; session_id: string | null; expires_at: string | null } | null;
  issued_at: string;
}

/**
 * Whether a chat grant still holds for the conversation's owner in its
 * classroom: it names that user and that classroom, and an impersonation
 * behind it has not expired (a grant that names one with no expiry does not
 * hold). The web sign-in session itself is not re-checked per turn.
 */
export const grantHolds = (
  grant: unknown,
  owner: { userId: string; classroomId: string },
  now: number
): boolean => {
  if (!isObject(grant)) return false;
  if (grant.effective_user_id !== owner.userId) return false;
  if (grant.classroom_id !== owner.classroomId) return false;
  const impersonation = grant.impersonation;
  if (impersonation === null || impersonation === undefined) return true;
  if (!isObject(impersonation) || typeof impersonation.expires_at !== 'string') return false;
  const expiresAt = Date.parse(impersonation.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
};

// ─── Re-delivery ────────────────────────────────────────────────────────────

/**
 * The stored row a re-delivered message id names, if any: what the
 * re-delivery rule compares the incoming message with.
 */
export const findStoredMessage = (tx: Tx, conversationId: string, uiMessageId: string) =>
  tx.aIConversationMessage.findUnique({
    where: {
      conversation_id_ui_message_id: {
        conversation_id: conversationId,
        ui_message_id: uiMessageId,
      },
    },
    select: { parts: true, role: true, created_at: true },
  });

/**
 * How far the reply to a stored user message got: the latest assistant row
 * written after it is `final` (the turn finished), `partial` (it was stopped
 * or failed after it began its reply), or there is `none` (the run crashed or
 * was handed over before it wrote anything).
 */
export type ReplyState = 'none' | 'partial' | 'final';

export const replyStateAfter = async (
  tx: Tx,
  conversationId: string,
  after: Date
): Promise<ReplyState> => {
  const reply = await tx.aIConversationMessage.findFirst({
    where: { conversation_id: conversationId, role: 'ASSISTANT', created_at: { gt: after } },
    orderBy: { created_at: 'desc' },
    select: { final: true },
  });
  return !reply ? 'none' : reply.final ? 'final' : 'partial';
};

/**
 * What a chat agent does with a re-delivered message (the same id and text
 * as an admitted one), by how far its reply got:
 *   rerun   admit it again without counting a new turn
 *   skip    its turn already finished: run nothing
 *   refuse  refuse it (the caller's conflict refusal)
 */
export type RedeliveryAction = 'rerun' | 'skip' | 'refuse';
export type RedeliveryPolicy = Readonly<Record<ReplyState, RedeliveryAction>>;

/**
 * The quiz: a turn that saved a partial reply is not run again for the same
 * message (what it committed stands, the student sends a new one); a turn
 * that wrote nothing yet is run again, as is one whose reply is final (a
 * retried run still answering the latest admission).
 */
export const QUIZ_REDELIVERY: RedeliveryPolicy = {
  none: 'rerun',
  partial: 'refuse',
  final: 'rerun',
};

/**
 * Ask Moji: its tools are read-only and nothing but the reply is written, so
 * a turn with no final reply is run again; one with a final reply is skipped.
 */
export const ASK_MOJI_REDELIVERY: RedeliveryPolicy = {
  none: 'rerun',
  partial: 'rerun',
  final: 'skip',
};
