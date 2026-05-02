import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';

/**
 * Build a JSON resource response in the shape MCP expects.
 */
export function jsonResource(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Resolve a classroom slug from the URI parameters and verify membership.
 * Resource templates pass URI variables as `slug` (or other named groups).
 */
export async function getClassroom(ctx: AuthContext, slug: string) {
  if (!slug) throw mcpError('classroomSlug is required', ErrorCode.InvalidParams);
  return resolveClassroom(ctx, slug);
}
