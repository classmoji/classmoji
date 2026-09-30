/**
 * The session route's two side effects, kept apart from its gates so each can
 * be replaced in tests: writing the attempt's chat grant, and starting (or
 * re-joining) the attempt's Trigger chat session.
 */
import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';

/** The Trigger task every quiz chat session runs. */
export const QUIZ_CHAT_TASK_ID = 'quiz-attempt';

/**
 * How long a session token lives (Q20: 15 minutes). The transport asks this
 * route again after a 401, and most turn-complete records carry a refreshed
 * token of the task's own `chatAccessTokenTTL`.
 */
export const QUIZ_CHAT_TOKEN_TTL = '15m';

/** Whether this deployment can reach Trigger at all. */
export const isTriggerConfigured = () =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);

/**
 * Who the session was issued to, written on the attempt before the session
 * starts. The task re-checks the attempt, the membership and the classroom
 * every turn; this record is what those checks and the audit trail read.
 * `web_session_id` is kept for the audit trail only (Q20).
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

export const writeChatGrant = async (attemptId: string, grant: ChatGrant) => {
  await getPrisma().quizAttempt.update({
    where: { id: attemptId },
    data: { chat_grant: grant as unknown as Prisma.InputJsonObject },
  });
};

export const recordTriggerSession = async (attemptId: string, sessionId: string) => {
  await getPrisma().quizAttempt.update({
    where: { id: attemptId },
    data: { trigger_session_id: sessionId },
  });
};

/**
 * Start the attempt's chat session, or join the one that exists: creation is
 * idempotent on the chat id (the attempt id), so the transport's token refresh
 * lands here too. Returns a token scoped to this one session (read and write
 * on `sessions:<attemptId>`), never a task-scoped one.
 */
export const startQuizChatSession = async (
  attemptId: string,
  tags: string[]
): Promise<{ publicAccessToken: string; sessionId: string }> => {
  const { chat } = await import('@trigger.dev/sdk/ai');
  const start = chat.createStartSessionAction(QUIZ_CHAT_TASK_ID, {
    tokenTTL: QUIZ_CHAT_TOKEN_TTL,
    triggerConfig: { tags },
  });
  const { publicAccessToken, sessionId } = await start({ chatId: attemptId, clientData: {} });
  return { publicAccessToken, sessionId };
};
