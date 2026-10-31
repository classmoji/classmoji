/**
 * What Ask Moji's tools share in public. The task offers every Classmoji MCP
 * read tool the user's token lists (`client.tools()`), each pinned to the
 * conversation's classroom, and gated by the MCP itself; it defines nothing
 * per tool here. Its one local tool is `cite_content`.
 *
 * The classroom roles and the role ceiling's order (`actingRole`, the MCP's
 * ceiling filter) are the one rule the task and the services both read.
 */

/** Classroom roles, weakest first. Plain strings: this module reaches the browser. */
export const ASK_MOJI_ROLES = ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER'] as const;
export type AskMojiRole = (typeof ASK_MOJI_ROLES)[number];

/** Rank of each role (higher = more privilege), the MCP role ceiling's order. */
export const ROLE_RANK: Readonly<Record<AskMojiRole, number>> = {
  STUDENT: 0,
  ASSISTANT: 1,
  TEACHER: 2,
  OWNER: 3,
};

export const isAskMojiRole = (value: unknown): value is AskMojiRole =>
  typeof value === 'string' && (ASK_MOJI_ROLES as readonly string[]).includes(value);

/**
 * The strongest of `roles` at or below `ceiling` (no ceiling: the strongest
 * of all), or null when none is. The MCP's ceiling filter, as a pure rule; a
 * ceiling that is not a role admits nothing.
 */
export function actingRole(
  roles: readonly string[],
  ceiling: string | null | undefined
): AskMojiRole | null {
  if (ceiling !== null && ceiling !== undefined && !isAskMojiRole(ceiling)) return null;
  const cap = ceiling ? ROLE_RANK[ceiling] : Infinity;
  let best: AskMojiRole | null = null;
  for (const role of roles) {
    if (!isAskMojiRole(role) || ROLE_RANK[role] > cap) continue;
    if (best === null || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

/** The task's local tool: a citation chip the server resolves. */
export const CITE_CONTENT_TOOL = 'cite_content';
