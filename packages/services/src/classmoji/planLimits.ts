import getPrisma from '@classmoji/database';
import type { SlideKind } from '@classmoji/database/client';
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
 * deleted row frees its slot. The slide limit counts slide DECKS only
 * (`countsTowardSlideLimit`): an uploaded file and a link are never counted and
 * never refused.
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
 *
 * Unlimited on Free too, deliberately (decided 2026-10-21): instructors
 * routinely run several sections at once, and a class cap would limit the core
 * use rather than a costly extra. The rule and everything around it (plan
 * owners, the locked lifecycle writes, the refusal and notice UI) stay in
 * place, so a number here turns it on everywhere. Measure concurrent usage
 * before choosing one.
 */
export const PLAN_ACTIVE_CLASSROOM_LIMITS: Record<'FREE' | 'PRO', number | null> = {
  FREE: null,
  PRO: null,
};

/** `code` on the Error `assertCanCreateContent` and `assertCanCreateSlide` throw. */
export const PLAN_CONTENT_LIMIT = 'PLAN_CONTENT_LIMIT';

/**
 * The one slide kind the slide limit counts. Uploaded files (`FILE`) and links
 * (`LINK`) are never counted and never refused (decided 2026-11-25).
 */
export const countsTowardSlideLimit = (kind: SlideKind): boolean => kind === 'DECK';

/** What the limit counts, in words (a slide limit is a limit on decks), singular and plural. */
const LIMITED_NOUNS: Record<LimitedContent, readonly [one: string, many: string]> = {
  pages: ['page', 'pages'],
  slides: ['slide deck', 'slide decks'],
};

const limitedContentNoun = (kind: LimitedContent, count = 2): string =>
  LIMITED_NOUNS[kind][count === 1 ? 0 : 1];

/**
 * What every surface says when the limit refuses (webapp, pages, slides, MCP),
 * so a teacher reads the same sentence wherever they hit it.
 */
export function contentLimitMessage(kind: LimitedContent, limit: number): string {
  const noun = limitedContentNoun(kind);
  const uncounted = kind === 'slides' ? " Uploaded files and links don't count." : '';
  return `Free classes can have up to ${limit} ${noun}.${uncounted} Upgrade to Pro for unlimited ${noun}.`;
}

/**
 * What an import says about the rows it left out for the limit, the same on
 * both import paths (class-to-class and the classroom-import workflow):
 * "skipped 1 slide deck. Free classes can …", "skipped 3 pages. Free classes …".
 */
export function skippedOverLimitText(kind: LimitedContent, skipped: number, limit: number): string {
  return `skipped ${skipped} ${limitedContentNoun(kind, skipped)}. ${contentLimitMessage(kind, limit)}`;
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
    : getPrisma().slide.count({ where: { classroom_id: classroomId, kind: 'DECK' } });

/**
 * The classroom's limit for `kind` and how much of it is used (for 'slides',
 * decks only). A Pro classroom is not counted at all.
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

const assertRoom = async (
  classroomId: string,
  kind: LimitedContent,
  count: number
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

/**
 * Refuse unless `count` more pages fit. Call it BEFORE any git write, so a
 * refused create leaves nothing behind in the content repo.
 *
 * A check, not a reservation: two creates racing at the last slot can both
 * pass. That costs a free class at most a page or two over, which is not worth
 * a lock around a create that commits to Github in the middle.
 *
 * Pages only: a slide create goes through `assertCanCreateSlide`, which has to
 * be told the kind, so no slide path can count a file or a link by mistake.
 *
 * @throws an Error with `code = PLAN_CONTENT_LIMIT` and `limit`, `used`.
 */
export const assertCanCreateContent = (
  classroomId: string,
  kind: 'pages',
  count = 1
): Promise<void> => assertRoom(classroomId, kind, count);

/**
 * Refuse a new slide of `slideKind` when it counts toward the limit and the
 * class has no room for `count` more decks; a file or a link always passes.
 * Same timing and race as `assertCanCreateContent`.
 *
 * @throws an Error with `code = PLAN_CONTENT_LIMIT` and `limit`, `used`.
 */
export const assertCanCreateSlide = async (
  classroomId: string,
  slideKind: SlideKind,
  count = 1
): Promise<void> => {
  if (!countsTowardSlideLimit(slideKind)) return;
  await assertRoom(classroomId, 'slides', count);
};

/**
 * The slides a target with room for `remaining` more decks takes from `rows`:
 * every file and link, and the first `remaining` decks, in the order given.
 * `skipped` is how many decks were left out. `remaining` null = unlimited.
 */
export function slidesWithinAllowance<T extends { kind: SlideKind }>(
  rows: T[],
  remaining: number | null
): { kept: T[]; skipped: number } {
  if (remaining === null) return { kept: rows, skipped: 0 };
  let room = remaining;
  let skipped = 0;
  const kept = rows.filter(row => {
    if (!countsTowardSlideLimit(row.kind)) return true;
    if (room > 0) {
      room--;
      return true;
    }
    skipped++;
    return false;
  });
  return { kept, skipped };
}

export const isContentLimitError = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && (error as { code?: unknown }).code === PLAN_CONTENT_LIMIT;
