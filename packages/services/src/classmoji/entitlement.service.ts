import getPrisma from '@classmoji/database';
import * as subscriptionService from './subscription.service.ts';

/**
 * Plan entitlement for AI features, shared by every app.
 *
 * This module does NOT decide what "Pro" means — `getProStateForClassroomId`
 * does, and every gate delegates to it so they cannot disagree. Quizzes reach
 * it through the webapp's `assertProTier` and the MCP's copy in
 * `apps/mcp/src/resources/content.ts` (and their settings switch through
 * `canUseQuizzes` here); the syllabus bot reaches it through here.
 * Reimplementing the tier rules (owner resolution, `ends_at`) in this file
 * would recreate the drift those call sites were consolidated to avoid.
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
 * Whether AI quizzes may be turned on for this classroom. Same rule as the
 * syllabus bot, through the same resolver the webapp's `assertProTier` serves
 * quizzes by, so the settings switch and the quiz routes cannot disagree. A
 * classroom's own key is not an access path here either.
 */
export const canUseQuizzes = async (classroomId: string): Promise<EntitlementResult> => {
  const { isPro } = await subscriptionService.getProStateForClassroomId(classroomId);
  return isPro ? ALLOWED : PRO_REQUIRED;
};

/**
 * Whether quizzes may appear in this classroom at all: Pro, and not switched
 * off in its settings. Every surface that lists, counts, links or schedules a
 * quiz (modules, dashboards, calendars and feeds, gradebook, notifications, the
 * public course site, MCP reads) filters on this one answer, so a classroom
 * without it shows no trace of quizzes and nothing links to a refusing route.
 *
 * Stored quizzes are untouched; they reappear when the classroom qualifies
 * again. The webapp wraps this as `loadQuizzesVisible`, which also requires the
 * AI agent to be configured and answers false on a failed lookup.
 */
export const quizzesVisible = async (classroomId: string): Promise<boolean> => {
  const [{ isPro }, settings] = await Promise.all([
    subscriptionService.getProStateForClassroomId(classroomId),
    getPrisma().classroomSettings.findUnique({
      where: { classroom_id: classroomId },
      select: { quizzes_enabled: true },
    }),
  ]);
  return isPro === true && settings?.quizzes_enabled !== false;
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
