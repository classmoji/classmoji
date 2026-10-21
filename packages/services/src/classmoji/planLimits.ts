import getPrisma from '@classmoji/database';
import * as subscriptionService from './subscription.service.ts';

/**
 * How many pages and slides a classroom may hold, in one place.
 *
 * Constants rather than env vars on purpose, for the same reason as
 * `media/mediaQuota.ts`: these are PRODUCT limits, what a plan includes, and an
 * env var would let staging, production and the Trigger worker disagree about
 * it. Changing a number is a code change.
 *
 * Counted per classroom, the unit Pro is resolved for
 * (`getProStateForClassroomId`). Drafts count; there is no soft delete, so a
 * deleted row frees its slot. A slide of any kind (deck, file, link) is one
 * slide.
 *
 * A free classroom already over a limit keeps everything it has: the limit only
 * refuses NEW rows. Nothing is hidden or deleted when a plan lapses, and
 * re-upgrading lifts the refusal.
 */

export type LimitedContent = 'pages' | 'slides';

/** `null` means unlimited. */
export const PLAN_CONTENT_LIMITS: Record<'FREE' | 'PRO', Record<LimitedContent, number | null>> = {
  FREE: { pages: 10, slides: 10 },
  PRO: { pages: null, slides: null },
};

/**
 * How many ACTIVE classrooms one person may be the plan owner of while none of
 * them is Pro (`classrooms.plan_owner_id`, see `planOwner.service.ts`).
 * Locked, unpublished and example classrooms do not count, and neither does a
 * classroom that is Pro because any accepted owner is. `null` = unlimited.
 */
export const PLAN_ACTIVE_CLASSROOM_LIMITS: Record<'FREE' | 'PRO', number | null> = {
  FREE: 1,
  PRO: null,
};

/** `code` on the Error `assertCanCreateContent` throws. */
export const PLAN_CONTENT_LIMIT = 'PLAN_CONTENT_LIMIT';

/**
 * What every surface says when the limit refuses (webapp, pages, slides, MCP),
 * so a teacher reads the same sentence wherever they hit it.
 */
export function contentLimitMessage(kind: LimitedContent, limit: number): string {
  return `Free classes can have up to ${limit} ${kind}. Upgrade to Pro for unlimited ${kind}.`;
}

export interface ContentAllowance {
  /** `null` = unlimited. */
  limit: number | null;
  used: number;
  /** How many more may be created; `null` = unlimited. Never negative. */
  remaining: number | null;
}

const countFor = (classroomId: string, kind: LimitedContent): Promise<number> =>
  kind === 'pages'
    ? getPrisma().page.count({ where: { classroom_id: classroomId } })
    : getPrisma().slide.count({ where: { classroom_id: classroomId } });

/**
 * The classroom's limit for `kind` and how much of it is used. A Pro classroom
 * is not counted at all.
 */
export const contentAllowance = async (
  classroomId: string,
  kind: LimitedContent
): Promise<ContentAllowance> => {
  const { isPro } = await subscriptionService.getProStateForClassroomId(classroomId);
  const limit = PLAN_CONTENT_LIMITS[isPro ? 'PRO' : 'FREE'][kind];
  if (limit === null) return { limit: null, used: 0, remaining: null };

  const used = await countFor(classroomId, kind);
  return { limit, used, remaining: Math.max(0, limit - used) };
};

/**
 * Refuse unless `count` more of `kind` fit. Call it BEFORE any git write, so a
 * refused create leaves nothing behind in the content repo.
 *
 * A check, not a reservation: two creates racing at the last slot can both
 * pass. That costs a free class at most a page or two over, which is not worth
 * a lock around a create that commits to Github in the middle.
 *
 * @throws an Error with `code = PLAN_CONTENT_LIMIT` and `limit`, `used`.
 */
export const assertCanCreateContent = async (
  classroomId: string,
  kind: LimitedContent,
  count = 1
): Promise<void> => {
  const { limit, used, remaining } = await contentAllowance(classroomId, kind);
  if (limit === null || remaining === null || remaining >= count) return;

  throw Object.assign(new Error(contentLimitMessage(kind, limit)), {
    code: PLAN_CONTENT_LIMIT,
    kind,
    limit,
    used,
  });
};

export const isContentLimitError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && (error as { code?: unknown }).code === PLAN_CONTENT_LIMIT;
