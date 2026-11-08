/**
 * `whoami` — trivial identity tool proving the enforcement pipeline
 * end-to-end (Phase 1b). Scope 'read', any authenticated user (roles: null).
 * Returns the caller's identity, their classrooms (one entry per classroom,
 * see memberships.ts) addressed in the composite `org/slug` form every other
 * tool accepts, and role-tailored example questions.
 */

import { ClassmojiService } from '@classmoji/services';
import { gitUsername } from '@classmoji/utils';
import type { ToolDefinition } from '../mcp/registry.ts';
import { buildSuggestions } from '../suggestions.ts';
import { summarizeMemberships } from '../memberships.ts';

export const whoamiTool: ToolDefinition<Record<string, never>> = {
  name: 'whoami',
  title: 'Who am I',
  description:
    'Returns the authenticated user (id, login, name), the scopes granted to this token, their ' +
    'classrooms (one entry per classroom, every role held there in `roles`), and ' +
    'role-tailored example questions to offer the user. my_classrooms returns the same ' +
    'identity and classrooms without the example questions. Classrooms are addressed as ' +
    "'org/slug' — use those references with other tools.",
  scope: 'read',
  roles: null,
  inputSchema: {},
  handler: async (_args, { viewer }) => {
    const user = await ClassmojiService.user.findById(viewer.userId);
    const classrooms = await ClassmojiService.classroom.findByUserId(viewer.userId);
    const memberships = summarizeMemberships(classrooms);

    const result = {
      userId: viewer.userId,
      login: gitUsername(user),
      name: user?.name ?? null,
      scopes: [...viewer.scopes],
      memberships,
      // Role-tailored conversation starters (cosmetic; from the roles held).
      suggestions: buildSuggestions(classrooms.map(c => c.membership.role)),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
};
