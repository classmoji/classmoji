import { z } from 'zod';
import type { AuthContext } from '../auth/context.ts';

export function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function classroomSlugSchema(ctx: AuthContext) {
  const validSlugs = ctx.classroomSlugs;
  return validSlugs.length > 0
    ? z.enum(validSlugs as [string, ...string[]]).optional()
    : z.string().optional();
}
