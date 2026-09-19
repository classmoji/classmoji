/**
 * The Pro-subscription gate, in MCP clothing.
 *
 * THE DECISION IS NOT MADE HERE. `@classmoji/auth/server`'s `assertProTier` is
 * the one implementation the whole platform gates on — the webapp's loaders and
 * actions (via the `~/utils/helpers` re-export), the forms subtree in
 * apps/pages, and now this server. This module is only the translation layer
 * between that helper's thrown 403 `Response` and the `ToolError` the registry
 * serializes into an `isError` tool result; it adds no rule of its own.
 *
 * ── What this retires ──────────────────────────────────────────────────────
 * apps/mcp used to carry its OWN `assertProTier` in resources/content.ts: a
 * hand-mirrored copy of the same gate that reached straight into
 * `subscription.getProStateForClassroomId` and raised its own error. Two
 * implementations of one product rule is exactly the drift that let a lapsed
 * `{ tier: 'PRO', ends_at: <past> }` row keep a feature open on one surface
 * after it had closed on another. `resources/content.ts` now re-exports this
 * function, so the quizzes read resource and the quiz write tools keep their
 * import path and their behavior.
 *
 * ── Slug, not id ───────────────────────────────────────────────────────────
 * The lifted helper resolves by SLUG (globally unique — schema.prisma,
 * `slug String @unique`). The slug handed to it is read off the classroom the
 * registry ALREADY resolved and role-gated (`ctx.classroom.classroom.slug`) —
 * never off a tool argument — so this cannot be pointed at a classroom the
 * caller was not authorized for, and it resolves to that same classroom.
 */

import { assertProTier as assertProTierOrThrowResponse } from '@classmoji/auth/server';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext } from '../mcp/registry.ts';

/**
 * Throw `ToolError('forbidden')` unless the caller's authorized classroom holds
 * an active Pro subscription. Call AFTER the registry's role gate, in-handler,
 * for every Pro-only surface (quizzes, forms).
 *
 * Only a thrown `Response` is translated: that is the shape the auth helper
 * uses for its 403. Anything else (a database failure, say) is rethrown
 * untouched so it surfaces as an internal error rather than as a bogus
 * "you need Pro".
 */
export async function assertProTier(ctx: ToolContext): Promise<void> {
  const classroom = ctx.classroom;
  if (!classroom) {
    throw new ToolError('internal', 'Classroom context missing (tool misregistered?)');
  }
  const slug = (classroom.classroom as { slug?: string | null } | null)?.slug;
  if (!slug) {
    throw new ToolError('internal', 'Authorized classroom is missing its slug');
  }

  try {
    await assertProTierOrThrowResponse(slug);
  } catch (thrown) {
    if (thrown instanceof Response) {
      // Same message the auth helper's 403 body carries, so the three surfaces
      // say the same thing to a user who hits the gate on any of them.
      throw new ToolError('forbidden', 'This feature requires a Pro subscription');
    }
    throw thrown;
  }
}
