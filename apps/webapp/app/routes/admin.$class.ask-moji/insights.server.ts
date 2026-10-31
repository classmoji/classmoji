/**
 * The gate and the audit rows of the Ask Moji insights screens (the page and
 * its exchange view, under /admin and /teacher).
 *
 * Who: OWNER or TEACHER of the classroom in the URL (assistants and students
 * are refused, and a denial is audited by the gate). Every read below is by
 * the classroom id the gate resolved, and the review rules take the viewer's
 * role from the gate's membership, never from the request.
 *
 * Where: only where Ask Moji runs (askMojiAvailable: the runtime switch,
 * Trigger, a key, Pro, enabled). Anywhere else the screens are 404, and no
 * VIEW row is written.
 *
 * Audit: every read of the classroom's Ask Moji activity is a VIEW row with
 * `data.tool` naming the surface, and `impersonated_by` while a platform
 * admin views as the user.
 */
import { ClassmojiService } from '@classmoji/services';
import { canonicalTimeZone } from '@classmoji/utils';
import { addClassroomAuditLog, assertClassroomAccess } from '~/utils/helpers';
import { impersonationAuditFields } from './impersonation.server';

export const INSIGHT_VIEWER_ROLES = ['OWNER', 'TEACHER'] as const;

export type InsightViewerRole = (typeof INSIGHT_VIEWER_ROLES)[number];

/** The audit `data.tool` of each read. */
export const INSIGHT_AUDIT_TOOLS = {
  usage: 'web:ask_moji.insights',
  review: 'web:ask_moji.feedback_review',
  exchange: 'web:ask_moji.exchange',
} as const;

export type InsightAccess = {
  userId: string;
  classroomId: string;
  viewerRole: InsightViewerRole;
  /** The course time zone (UTC when unset or unknown). */
  timeZone: string;
  audit: (row: {
    resourceType: string;
    resourceId: string;
    tool: (typeof INSIGHT_AUDIT_TOOLS)[keyof typeof INSIGHT_AUDIT_TOOLS];
    data?: Record<string, unknown>;
  }) => Promise<void>;
};

export async function requireAskMojiInsights(
  request: Request,
  classroomSlug: string,
  attemptedAction: string
): Promise<InsightAccess> {
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: [...INSIGHT_VIEWER_ROLES],
    resourceType: 'ASK_MOJI_INSIGHTS',
    attemptedAction,
  });

  const availability = await ClassmojiService.askMojiSession.askMojiAvailable({
    classroomId: classroom.id,
  });
  if (!availability.available) throw new Response('Not Found', { status: 404 });

  const viewerRole = membership!.role as InsightViewerRole;
  const settings = classroom.settings as { timezone?: string | null } | null | undefined;
  const timeZone = canonicalTimeZone(settings?.timezone) ?? 'UTC';
  const impersonation = await impersonationAuditFields(request);

  return {
    userId,
    classroomId: classroom.id,
    viewerRole,
    timeZone,
    audit: ({ resourceType, resourceId, tool, data }) =>
      addClassroomAuditLog({
        classroomId: classroom.id,
        userId,
        role: viewerRole,
        action: 'VIEW',
        resourceType,
        resourceId,
        metadata: { tool, ...data, ...impersonation },
      }),
  };
}
