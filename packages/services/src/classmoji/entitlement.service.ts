import getPrisma from '@classmoji/database';
import * as subscriptionService from './subscription.service.ts';

/**
 * Plan entitlement for AI features, shared by every app.
 *
 * This module does NOT decide what "Pro" means — `getProStateForClassroomId`
 * does, and every gate delegates to it so they cannot disagree. Quizzes reach
 * it through the webapp's `assertProTier` and the MCP's copy in
 * `apps/mcp/src/resources/content.ts`; the syllabus bot reaches it through
 * here. Reimplementing the tier rules (owner resolution, `ends_at`) in this
 * file would recreate the drift those call sites were consolidated to avoid.
 *
 * Entitlement is evaluated at SERVE time, never stored. A feature flag such as
 * `syllabus_bot_enabled` is necessary but not sufficient: a classroom whose
 * plan lapses stops being served without anyone rewriting its settings, and
 * re-upgrading restores the previous state untouched.
 *
 * Addressed by classroom ID rather than slug, matching
 * `getProStateForClassroomId` — every caller already holds a classroom from its
 * access check, an id cannot be re-pointed by a rename, and it keeps this off
 * the extra lookup that the config loader (hit on every classroom navigation,
 * by every user) would otherwise pay.
 */

export type EntitlementDenialReason = 'pro_required' | 'not_found';

export type EntitlementResult =
  | { allowed: true }
  | { allowed: false; reason: EntitlementDenialReason };

const ALLOWED: EntitlementResult = { allowed: true };
const PRO_REQUIRED: EntitlementResult = { allowed: false, reason: 'pro_required' };
const NOT_FOUND: EntitlementResult = { allowed: false, reason: 'not_found' };

/**
 * Whether the syllabus bot may be served for this classroom.
 *
 * Pro-only, matching quizzes. Bring-your-own-key is intentionally NOT an access
 * path: `apps/ai-agent/src/llm/services/syllabusBot.js` falls back to the
 * platform key when the classroom key is empty, so "has a key" is not a safe
 * entitlement signal, and a non-empty key is not necessarily a working one. If
 * BYOK ever becomes a deliberate tier it should be designed once across every
 * AI feature — changing it starts here.
 */
export const canUseSyllabusBot = async (classroomId: string): Promise<EntitlementResult> => {
  const { isPro } = await subscriptionService.getProStateForClassroomId(classroomId);
  return isPro ? ALLOWED : PRO_REQUIRED;
};

/**
 * Same check, addressed by conversation — for the SSE stream route, which only
 * knows a conversation id.
 *
 * An unknown conversation is denied: the stream has no legitimate use for one
 * that does not exist. Reported as 'not_found' rather than 'pro_required' so a
 * data-integrity problem never renders to an owner as "buy Pro".
 */
export const canUseSyllabusBotForConversation = async (
  conversationId: string
): Promise<EntitlementResult> => {
  const conversation = await getPrisma().aIConversation.findUnique({
    where: { id: conversationId },
    select: { classroom_id: true },
  });

  if (!conversation) {
    return NOT_FOUND;
  }

  return canUseSyllabusBot(conversation.classroom_id);
};
