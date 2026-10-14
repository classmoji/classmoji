/**
 * A chat attempt past its session deadline, met where it is read.
 *
 * A `trigger_chat` attempt takes no turns after `session_expires_at` (30 days
 * after it was created), and nothing else ever completes it. Wherever the
 * webapp meets one still open (the attempt drawers, the session route), it is
 * closed there with the results recorded so far
 * (`quizGrading.closeExpiredAttempt`, which re-reads the row under its lock
 * and does nothing unless it is still open and expired), so it is shown, and
 * graded, as a completed attempt rather than a chat that can never continue.
 *
 * Callers close only after their own gates have bound the attempt to the
 * caller (their own attempt, or staff of its quiz's classroom). The actor is
 * the signed-in caller, from the session and their membership.
 */
import type { Role } from '@prisma/client';

export interface ExpirableAttempt {
  id: string;
  agent_runtime?: string | null;
  completed_at?: Date | string | null;
  session_expires_at?: Date | string | null;
}

export type ExpiredCloseActor = {
  userId: string;
  role: Role;
  surface: 'session' | 'own_attempt_view' | 'staff_attempt_view' | 'preview_attempt_view';
};

/**
 * Open, on the chat runtime, and past its deadline: the same rule as turn
 * admission and `quizGrading.isExpiredOpenAttempt`. No deadline: never.
 */
export const isExpiredOpenChatAttempt = (
  attempt: Omit<ExpirableAttempt, 'id'> | null | undefined,
  now: Date = new Date()
): boolean => {
  if (!attempt || attempt.agent_runtime !== 'trigger_chat' || attempt.completed_at) return false;
  if (!attempt.session_expires_at) return false;
  const deadline = new Date(attempt.session_expires_at).getTime();
  return Number.isFinite(deadline) && deadline <= now.getTime();
};

/**
 * Close the attempt if it is open and past its deadline. True when it was
 * (by this call or a racing one): the caller then reads the attempt again.
 */
export const closeIfExpired = async (
  attempt: ExpirableAttempt,
  actor: ExpiredCloseActor
): Promise<boolean> => {
  if (!isExpiredOpenChatAttempt(attempt)) return false;
  const { ClassmojiService } = await import('@classmoji/services');
  await ClassmojiService.quizGrading.closeExpiredAttempt(String(attempt.id), actor);
  return true;
};
