/**
 * `me` — identity/bootstrap resource (static URI, any authenticated user).
 *
 * Locked decision 8: return ALL memberships with `is_archived` + `status`
 * flags — no filtering (web parity). Per-classroom entry gates still block a
 * non-owner from reading an UNPUBLISHED classroom's *contents* through the
 * classroom-bound resources; the listing itself is not a leak (the web app's
 * classroom picker shows the same rows).
 */

import { ClassmojiService } from '@classmoji/services';
import type { ResourceDefinition } from '../mcp/registry.ts';
import { buildSuggestions } from '../suggestions.ts';

export const meResource: ResourceDefinition = {
  name: 'me',
  uriTemplate: 'classmoji://me',
  title: 'My identity & classrooms',
  description:
    'The authenticated user (id, login, name), granted scopes, every classroom membership ' +
    '(one row per role) with status and archive flags, and role-tailored example questions to ' +
    "offer the user. Classrooms are addressed as 'org/slug' in all other resource URIs.",
  scope: 'read',
  roles: null,
  handler: async (_vars, { viewer }) => {
    const user = await ClassmojiService.user.findById(viewer.userId);
    // One entry per membership row (a user can hold several roles per classroom).
    const classrooms = await ClassmojiService.classroom.findByUserId(viewer.userId);

    return {
      userId: viewer.userId,
      login: user?.login ?? null,
      name: user?.name ?? null,
      scopes: [...viewer.scopes],
      memberships: classrooms.map(c => ({
        classroom: `${c.git_organization?.login ?? 'unknown'}/${c.slug}`,
        name: c.name,
        role: c.membership.role,
        status: c.status,
        is_archived: c.is_archived,
      })),
      // Role-tailored conversation starters (cosmetic; from the roles held).
      suggestions: buildSuggestions(classrooms.map(c => c.membership.role)),
    };
  },
};
