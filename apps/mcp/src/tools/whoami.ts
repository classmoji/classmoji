/**
 * `whoami` — trivial identity tool proving the enforcement pipeline
 * end-to-end (Phase 1b). Scope 'read', any authenticated user (roles: null).
 * Returns the caller's identity plus a summary of classroom memberships,
 * addressed in the composite `org/slug` form every other tool accepts.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ToolDefinition } from '../mcp/registry.ts';
import { buildSuggestions } from '../suggestions.ts';

interface MembershipSummary {
  classroom: string;
  name: string;
  role: string;
  status: string;
  is_archived: boolean;
}

export const whoamiTool: ToolDefinition<Record<string, never>> = {
  name: 'whoami',
  title: 'Who am I',
  description:
    'Returns the authenticated user (id, login, name), the scopes granted to this token, a ' +
    'summary of classroom memberships, and role-tailored example questions to offer the user. ' +
    "Classrooms are addressed as 'org/slug' — use those references with other tools.",
  scope: 'read',
  roles: null,
  inputSchema: {},
  handler: async (_args, { viewer }) => {
    const user = await ClassmojiService.user.findById(viewer.userId);
    // One entry per membership row (a user can hold several roles per classroom).
    const classrooms = await ClassmojiService.classroom.findByUserId(viewer.userId);

    const memberships: MembershipSummary[] = classrooms.map(c => ({
      classroom: `${c.git_organization?.login ?? 'unknown'}/${c.slug}`,
      name: c.name,
      role: c.membership.role,
      status: c.status,
      is_archived: c.is_archived,
    }));

    const result = {
      userId: viewer.userId,
      login: user?.login ?? null,
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
