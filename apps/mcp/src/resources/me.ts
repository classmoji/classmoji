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
import { gitUsername } from '@classmoji/utils';
import type { ResourceDefinition } from '../mcp/registry.ts';
import { summarizeMemberships } from '../memberships.ts';

export const meResource: ResourceDefinition = {
  name: 'me',
  uriTemplate: 'classmoji://me',
  title: 'My identity & classrooms',
  description:
    'The authenticated user (id, login, name), granted scopes, and every classroom membership: ' +
    'one entry per classroom, with every role held there in `roles` (highest first; `role` is ' +
    "the highest), status and archive flags. Classrooms are addressed as 'org/slug' in all " +
    'other resource URIs.',
  scope: 'read',
  roles: null,
  handler: async (_vars, { viewer }) => {
    const user = await ClassmojiService.user.findById(viewer.userId);
    const classrooms = await ClassmojiService.classroom.findByUserId(viewer.userId);

    // The full list, one entry per classroom. The example questions are
    // `whoami`'s, so this and its `my_classrooms` mirror don't repeat it.
    return {
      userId: viewer.userId,
      login: gitUsername(user),
      name: user?.name ?? null,
      scopes: [...viewer.scopes],
      memberships: summarizeMemberships(classrooms),
    };
  },
};
