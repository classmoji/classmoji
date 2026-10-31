/**
 * Project gallery moderation tools — form_gallery_queue / form_gallery_moderate.
 *
 * Mirrors the pages routes `/{class}/forms/{slug}/gallery` (the queue) and
 * `/{class}/forms/{slug}/responses/gallery` (Approve / Hide). Both are gated on
 * the TEACHING TEAM, assistants included, and neither checks Pro: moderation is
 * TA work, and hiding a project from a lapsed term must still work. The forms
 * tools (forms.ts) are OWNER | TEACHER + Pro because the rest of the forms
 * surface is; these two are deliberately not.
 *
 * Turning a form's gallery on or off is form_update `gallery` (owner only), as
 * the builder's switch is.
 *
 * Audit rows use the web's vocabulary (`forms.responses.gallery_status`) with
 * `via: 'mcp'` and `mcp_tool`, like every forms tool (see forms.ts).
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  TEACHING_TEAM,
  loadFormInClassroom,
  ok,
  requireClassroomCtx,
  scopedNotFound,
} from './shared.ts';

const FORMS_RESOURCE = 'FORMS';

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");
const formIdArg = z.string().uuid().describe('Form id (a form that feeds the project gallery)');

type GalleryForm = { id: string; classroom_id: string; gallery_org_id?: string | null };

/** A form of this classroom that feeds the gallery; any other is not found. */
async function loadGalleryForm(
  formId: string,
  ctx: Parameters<typeof loadFormInClassroom>[1]
): Promise<GalleryForm> {
  const form = await loadFormInClassroom<GalleryForm>(formId, ctx);
  // A form that does not feed the gallery answers like a missing one, as on the web.
  if (!form.gallery_org_id) throw scopedNotFound('Form');
  return form;
}

// ─── form_gallery_queue ─────────────────────────────────────────────────────

interface FormGalleryQueueArgs {
  classroom: string;
  form_id: string;
}

export const formGalleryQueueTool: ToolDefinition<FormGalleryQueueArgs> = {
  name: 'form_gallery_queue',
  title: 'List a gallery form’s projects for moderation',
  description:
    'The moderation queue of a form that feeds the org project gallery: each submitted ' +
    'response’s id, project title and gallery_status (PENDING, APPROVED or HIDDEN). Only ' +
    'APPROVED projects are public. No name, email or other answer is returned. Teaching team ' +
    '(owner, teacher or assistant). Use form_gallery_moderate to approve or hide.',
  scope: 'read',
  roles: TEACHING_TEAM,
  annotations: { openWorld: false },
  // Students' submissions (their project titles), as on the web queue.
  auditRead: {
    resourceType: FORMS_RESOURCE,
    ids: args => ({ resourceId: String(args.form_id) }),
  },
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
  },
  handler: async (args, ctx) => {
    const form = await loadGalleryForm(args.form_id, ctx);
    const items = await ClassmojiService.gallery.queueForForm(form.id);
    return ok({
      form_id: form.id,
      projects: items.map(item => ({
        response_id: item.id,
        title: item.title,
        gallery_status: item.galleryStatus,
        // Quote it back to form_gallery_moderate: an approval publishes only
        // a response unchanged since this read.
        updated_at: item.updatedAt,
      })),
    });
  },
};

// ─── form_gallery_moderate ──────────────────────────────────────────────────

interface FormGalleryModerateArgs {
  classroom: string;
  form_id: string;
  responses: Array<{ response_id: string; updated_at: string }>;
  status: 'APPROVED' | 'HIDDEN' | 'PENDING';
}

export const formGalleryModerateTool: ToolDefinition<FormGalleryModerateArgs> = {
  name: 'form_gallery_moderate',
  title: 'Approve or hide gallery projects',
  description:
    'Sets the gallery_status of submitted responses of a gallery form: APPROVED publishes the ' +
    'project on the org’s PUBLIC project gallery (every class site in the org, visible to ' +
    'anyone), HIDDEN or PENDING takes it off. Pass each response_id with the updated_at ' +
    'form_gallery_queue returned: a response edited since is not approved and comes back in ' +
    '`stale` (read the queue again and review it). Ids that are not submitted responses of ' +
    `this form are ignored. Up to ${ClassmojiService.gallery.GALLERY_MODERATION_MAX} ` +
    'responses per call. Teaching team (owner, teacher or assistant).',
  scope: 'write',
  roles: TEACHING_TEAM,
  // Reversible (hide again), but APPROVED publishes students' work to the open
  // web, so clients confirm first.
  annotations: { destructive: true, idempotent: true, openWorld: true },
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    responses: z
      .array(
        z.object({
          response_id: z.string().uuid(),
          updated_at: z.string().datetime().describe('As form_gallery_queue returned it'),
        })
      )
      .min(1)
      .max(ClassmojiService.gallery.GALLERY_MODERATION_MAX)
      .describe('Responses to moderate, from form_gallery_queue'),
    status: z
      .enum(['APPROVED', 'HIDDEN', 'PENDING'])
      .describe('APPROVED shows it publicly; HIDDEN or PENDING keeps it off the gallery'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const form = await loadGalleryForm(args.form_id, ctx);

    const { updated, stale } = await ClassmojiService.gallery.setStatuses({
      formId: form.id,
      responseIds: args.responses.map(entry => entry.response_id),
      status: args.status,
      versions: Object.fromEntries(
        args.responses.map(entry => [entry.response_id, entry.updated_at])
      ),
      audit: {
        user_id: ctx.viewer.userId,
        classroom_id: classroom.classroomId,
        role: classroom.role,
        resource_type: FORMS_RESOURCE,
        data: {
          tool: 'forms.responses.gallery_status',
          via: 'mcp',
          mcp_tool: 'form_gallery_moderate',
          ...(ctx.viewer.impersonatedBy ? { impersonated_by: ctx.viewer.impersonatedBy } : {}),
        },
      },
    });
    if (!updated && !stale.length) {
      throw new ToolError('invalid_params', 'No submitted responses of this form match those ids');
    }

    return ok({
      success: stale.length === 0,
      updated,
      gallery_status: args.status,
      ...(stale.length
        ? {
            stale,
            message:
              'These responses changed since form_gallery_queue was read and were not approved. ' +
              'Read the queue again and review them.',
          }
        : {}),
    });
  },
};
