/**
 * `classroom-info` — classmoji://{org}/{slug} (any member).
 *
 * Mirrors what assertClassroomAccess hands every web loader: the classroom
 * sanitized via ClassmojiService.classroom.getClassroomForUI (SAFE_SETTINGS_FIELDS
 * whitelist; raw API keys replaced with has_anthropic_key / has_openai_key
 * booleans). The registry already resolved + sanitized it in ClassroomContext.
 *
 * One deliberate tightening over the web: the webapp returns the FULL
 * git_organization row on the classroom object (including the encrypted
 * `access_token` column for non-GitHub providers — a known over-fetch). Here
 * the organization is narrowed to public identity fields.
 */

import type { ResourceDefinition } from '../mcp/registry.ts';
import { MEMBER, classroomCtx } from './shape.ts';

interface SanitizedClassroom {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_archived: boolean;
  is_example?: boolean;
  created_at?: Date | string;
  updated_at?: Date | string;
  settings?: Record<string, unknown> | null;
  git_organization?: {
    login?: string | null;
    provider?: string | null;
    base_url?: string | null;
  } | null;
}

export const classroomInfoResource: ResourceDefinition = {
  name: 'classroom-info',
  uriTemplate: 'classmoji://{org}/{slug}',
  title: 'Classroom info',
  description:
    'Classroom name, status, archive flag, and sanitized settings (feature flags, LLM model ' +
    'choices, has_anthropic_key/has_openai_key booleans — never raw keys), plus your role in it.',
  scope: 'read',
  roles: MEMBER,
  handler: async (_vars, ctx) => {
    const resolved = classroomCtx(ctx);
    const classroom = resolved.classroom as unknown as SanitizedClassroom;
    const org = classroom.git_organization;

    return {
      id: classroom.id,
      classroom: `${org?.login ?? 'unknown'}/${classroom.slug}`,
      name: classroom.name,
      status: classroom.status,
      is_archived: classroom.is_archived,
      is_example: classroom.is_example ?? false,
      // Sanitized by getClassroomForUI: SAFE_SETTINGS_FIELDS + has_*_key booleans.
      settings: classroom.settings ?? null,
      organization: org
        ? {
            login: org.login ?? null,
            provider: org.provider ?? null,
            base_url: org.base_url ?? null,
          }
        : null,
      viewer_role: resolved.role,
    };
  },
};
