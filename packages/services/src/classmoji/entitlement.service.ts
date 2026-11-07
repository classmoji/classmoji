import getPrisma from '@classmoji/database';
import * as subscriptionService from './subscription.service.ts';
import { isTriggerConfigured } from '../helper/triggerConfig.ts';

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

export type EntitlementDenialReason = 'pro_required';

export type EntitlementResult =
  | { allowed: true }
  | { allowed: false; reason: EntitlementDenialReason };

const ALLOWED: EntitlementResult = { allowed: true };
const PRO_REQUIRED: EntitlementResult = { allowed: false, reason: 'pro_required' };

/**
 * Whether the syllabus bot may be served for this classroom.
 *
 * Pro-only, matching quizzes. Bring-your-own-key is intentionally NOT an access
 * path: Ask Moji falls back to the platform key when the classroom key is
 * empty, so "has a key" is not a safe entitlement signal, and a non-empty key
 * is not necessarily a working one. If
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
 * Whether quizzes may appear in this classroom at all: the quiz runtime is
 * configured in this process (`isQuizRuntimeConfigured`), the classroom is
 * Pro, and quizzes are not switched off in its settings. Every surface that
 * lists, counts, links or schedules a quiz (modules, dashboards, calendars and
 * feeds, gradebook, notifications, the public course site, MCP reads and
 * writes) filters on this one answer, so a classroom without it shows no trace
 * of quizzes and nothing links to a refusing route. No Trigger key, no
 * quizzes anywhere.
 *
 * Without the runtime it answers false before any database read. A failed
 * lookup THROWS, never answers false: a database blip must not drop every quiz
 * out of a student's total. The webapp's `loadQuizzesVisible`
 * (`~/utils/classroomProFlag.server`) is the rendering wrapper that answers
 * false on a failed lookup instead.
 *
 * Stored quizzes are untouched; they reappear when the classroom qualifies
 * again. Takes a classroom id the caller has already authorized.
 *
 * Code running INSIDE a Trigger worker uses `quizzesEntitled` instead.
 */
export const quizzesVisible = async (classroomId: string): Promise<boolean> => {
  if (!isQuizRuntimeConfigured()) return false;
  return quizzesEntitled(classroomId);
};

/**
 * The classroom half of `quizzesVisible`, with no runtime check: Pro, and not
 * switched off in its settings. A failed lookup throws.
 *
 * ONLY for code that runs inside a Trigger worker (the quiz chat task's
 * per-turn admission, Ask Moji's viewing resolver). The worker IS the quiz
 * runtime, and its process env may lack the Trigger key the web and MCP
 * processes are judged by, so asking `quizzesVisible` there would refuse every
 * turn. Everywhere else, use `quizzesVisible`.
 */
export const quizzesEntitled = async (classroomId: string): Promise<boolean> => {
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
 * Whether the quiz runtime is configured in THIS process: Trigger.dev keys are
 * set (`isTriggerConfigured`, the one shared rule). Quizzes run only on the
 * Trigger chat runtime, so without it no quiz can start and none is shown.
 */
export const isQuizRuntimeConfigured = (): boolean => isTriggerConfigured();

/**
 * The same answer as `quizzesVisible`, under the name the grade totals
 * (gradebook, student report, leaderboard, MCP grade reads) and the quiz
 * routes call it by; it says at the call site that a failed lookup throws.
 * The webapp's `quizzesVisibleOrThrow` (`~/utils/classroomProFlag.server`)
 * delegates here.
 */
export const quizzesVisibleOrThrow = (classroomId: string): Promise<boolean> =>
  quizzesVisible(classroomId);
