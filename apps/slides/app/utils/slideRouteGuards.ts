/**
 * slideRouteGuards.ts — the two checks a `/{classroomSlug}/{slideId}/…` screen
 * makes once `assertSlideAccess` has admitted the caller.
 *
 * Neither is about permission, and that is exactly why they are easy to leave
 * out. `assertSlideAccess` answers "may this person edit this slide?"; it says
 * nothing about whether the slide is the one the URL claims, or whether the
 * screen can do anything with it:
 *
 *   - **the classroom.** Staff of classroom A reaching classroom B's slide
 *     through A's path is not a permission failure — the gate above already
 *     said no if they had no rights on B — but it is a URL that lies, and it
 *     lands the author back on A's list wondering what they just changed.
 *   - **the kind.** "Replace file" on a link slide and "edit link" on a deck
 *     are screens with nothing to act on, and the services behind them refuse
 *     anyway; refusing here makes the answer a 404 about the screen rather than
 *     an error about a service.
 *
 * Pure: `Response` objects built out of values the caller already has, so
 * `tests/unit` can pin both without a database.
 */

import { slideTextResponse } from './slideKind';

/** The slide shape these checks read, and nothing more of it. */
export interface GuardedSlide {
  kind?: string | null;
  classroom?: { slug?: string | null } | null;
}

/**
 * The slug in the URL must be the slide's OWN classroom.
 *
 * 403 rather than 404: the caller was admitted to this slide by the gate above,
 * so there is nothing to hide from them — what is wrong is the path they used.
 */
export function assertSlideInClassroom(slide: GuardedSlide, classroomSlug: string): void {
  if (slide.classroom?.slug !== classroomSlug) {
    throw slideTextResponse('Slide does not belong to this classroom', 403);
  }
}

/**
 * This screen is for one kind of slide, and this is not it.
 *
 * The message is the caller's, because "no file to replace" and "no link to
 * edit" are the same refusal about different screens.
 */
export function assertSlideKind(slide: GuardedSlide, expected: string, message: string): void {
  if (slide.kind !== expected) {
    throw slideTextResponse(message, 404);
  }
}
