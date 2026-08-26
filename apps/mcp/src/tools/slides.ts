/**
 * Slide tools (content-tools plan Phase 5, §7):
 * list_slides / slide_create / slide_update / slide_delete.
 *
 * Tier: reading a deck and editing it are two different rules, deliberately.
 *   VIEW  — the whole TEACHING TEAM (OWNER/TEACHER/ASSISTANT) sees every deck
 *           of their classroom, drafts included; students see published decks
 *           only. This matches the slides app's own list (apps/slides
 *           routes/_index), which has always shown drafts to all three staff
 *           roles, and the shared view gate (assertSlideAccess, auth/server.ts).
 *   EDIT  — narrower and unchanged: OWNER/TEACHER edit any deck; an ASSISTANT
 *           only decks they created or decks with allow_team_edit (decided:
 *           slide_delete mirrors the web too — assistants may delete own /
 *           team-edit decks). Enforced by the assertSlideEditable sub-gate.
 * Do not collapse the two back together: a staff member reading a colleague's
 * work-in-progress deck is expected; writing to it is not.
 *
 * S1: every by-id tool loads the slide WITH its classroom chain and compares
 * classroom_id before mutating (loadSlideInClassroom).
 */

import { slideService } from '@classmoji/services/slides';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { MEMBER, isStaff } from '../resources/shape.ts';
import {
  assertSlideEditable,
  loadSlideInClassroom,
  ok,
  requireClassroomCtx,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && (current as { code?: string }).code === code) return true;
    current = current.cause;
  }
  return false;
}

interface SlideRow {
  id: string;
  title: string;
  slug: string;
  is_draft: boolean;
  is_public: boolean;
  allow_team_edit: boolean;
  show_speaker_notes: boolean;
  created_by: string;
  updated_at: Date | string;
}

// ─── list_slides ─────────────────────────────────────────────────────────────

interface ListSlidesArgs {
  classroom: string;
}

export const listSlidesTool: ToolDefinition<ListSlidesArgs> = {
  name: 'list_slides',
  title: 'List slide decks',
  description:
    "Lists the classroom's slide decks. The teaching team (OWNER/TEACHER/ASSISTANT) sees every " +
    'deck incl. drafts (with visibility flags); students see the published list. Use ' +
    "deck_outline/deck_get to read a deck's content.",
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
  },
  handler: async (_args, ctx) => {
    const { classroomId, role } = requireClassroomCtx(ctx);

    // Full listing = the teaching team, matching the view tier of the shared
    // slide gate and the slides app's own list. Keeping the listing in step
    // with deck_get/deck_outline means a deck a staff member may open is also
    // a deck they can find.
    if (isStaff(role)) {
      const slides = (await slideService.findByClassroomId(classroomId, {
        includeDrafts: true,
      })) as SlideRow[];
      return ok({
        slides: slides.map(s => ({
          id: s.id,
          title: s.title,
          slug: s.slug,
          is_draft: s.is_draft,
          is_public: s.is_public,
          allow_team_edit: s.allow_team_edit,
          show_speaker_notes: s.show_speaker_notes,
          created_by: s.created_by,
          updated_at: s.updated_at,
        })),
      });
    }

    const slides = (await slideService.findByClassroomId(classroomId, {
      includeDrafts: false,
    })) as SlideRow[];
    return ok({
      slides: slides.map(s => ({
        id: s.id,
        title: s.title,
        slug: s.slug,
        updated_at: s.updated_at,
      })),
    });
  },
};

// ─── slide_create ────────────────────────────────────────────────────────────

interface SlideCreateArgs {
  classroom: string;
  title: string;
}

export const slideCreateTool: ToolDefinition<SlideCreateArgs> = {
  name: 'slide_create',
  annotations: { destructive: false, openWorld: true },
  title: 'Create a slide deck',
  description:
    'Creates a new reveal.js slide deck: the canonical 4-slide starter deck committed to the ' +
    "classroom's shared content repo on GitHub (deck.json + generated index.html in one " +
    'commit), the database record (created as a draft), and a content-manifest refresh. Edit ' +
    'its content with deck_apply; publish it with slide_update (is_draft: false).',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    title: z.string().min(1).max(200).describe('Deck title (its slug/content path derive from it)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    try {
      const { slide, sha } = await slideService.createSlide({
        classroomId: classroom.classroomId,
        title: args.title,
        createdBy: ctx.viewer.userId,
      });

      await writeAudit(ctx, {
        resource_type: 'SLIDES',
        resource_id: slide.id,
        action: 'CREATE',
        data: { tool: 'slide_create', title: args.title } as Prisma.InputJsonValue,
      });

      return ok({
        success: true,
        slide: {
          id: slide.id,
          title: slide.title,
          slug: slide.slug,
          content_path: slide.content_path,
          is_draft: slide.is_draft,
          is_public: slide.is_public,
        },
        // The starter deck's sha — the expected_sha for an immediate deck_apply.
        sha,
        sha_source: 'deck',
      });
    } catch (error) {
      if (hasErrorCode(error, slideService.SLIDE_CONTENT_PATH_CONFLICT)) {
        throw new ToolError('invalid_params', (error as Error).message);
      }
      if (hasErrorCode(error, 'P2002')) {
        throw new ToolError(
          'invalid_params',
          'A slide deck with this title already exists in this classroom'
        );
      }
      throw error;
    }
  },
};

// ─── slide_update ────────────────────────────────────────────────────────────

interface SlideUpdateArgs {
  classroom: string;
  slide_id: string;
  title?: string;
  is_draft?: boolean;
  is_public?: boolean;
  allow_team_edit?: boolean;
  show_speaker_notes?: boolean;
}

export const slideUpdateTool: ToolDefinition<SlideUpdateArgs> = {
  name: 'slide_update',
  annotations: { destructive: false, openWorld: false },
  title: 'Update slide deck metadata',
  description:
    "Updates a slide deck's metadata: title, draft/published state, public visibility, " +
    'team-edit permission, and speaker-notes visibility. Deck CONTENT is edited with ' +
    'deck_apply, not here. Title changes keep the slug and content path (set once at ' +
    'creation). OWNER/TEACHER may update any deck; an ASSISTANT only decks they created or ' +
    'decks with allow_team_edit.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('New title (slug/content path unchanged)'),
    is_draft: z
      .boolean()
      .optional()
      .describe('true = draft (only editors can view), false = published'),
    is_public: z.boolean().optional().describe('Whether the deck is publicly viewable'),
    allow_team_edit: z
      .boolean()
      .optional()
      .describe('Allow any assistant on the teaching team to edit this deck'),
    show_speaker_notes: z
      .boolean()
      .optional()
      .describe('Show speaker notes to anyone who can view (staff always see them)'),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(slide, ctx);

    const updates = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.is_draft !== undefined ? { is_draft: args.is_draft } : {}),
      ...(args.is_public !== undefined ? { is_public: args.is_public } : {}),
      ...(args.allow_team_edit !== undefined ? { allow_team_edit: args.allow_team_edit } : {}),
      ...(args.show_speaker_notes !== undefined
        ? { show_speaker_notes: args.show_speaker_notes }
        : {}),
    };
    const fields = Object.keys(updates);
    if (fields.length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one field to update');
    }

    const updated = (await slideService.updateSlide(slide.id, updates)) as SlideRow;

    await writeAudit(ctx, {
      resource_type: 'SLIDES',
      resource_id: slide.id,
      action: 'UPDATE',
      data: { tool: 'slide_update', fields } as Prisma.InputJsonValue,
    });

    return ok({
      success: true,
      slide: {
        id: slide.id,
        title: updated.title,
        slug: updated.slug ?? slide.slug,
        is_draft: updated.is_draft,
        is_public: updated.is_public,
        allow_team_edit: updated.allow_team_edit,
        show_speaker_notes: updated.show_speaker_notes,
      },
    });
  },
};

// ─── slide_delete ────────────────────────────────────────────────────────────

interface SlideDeleteArgs {
  classroom: string;
  slide_id: string;
}

export const slideDeleteTool: ToolDefinition<SlideDeleteArgs> = {
  name: 'slide_delete',
  annotations: { destructive: true, openWorld: true },
  title: 'Delete a slide deck',
  description:
    "Permanently deletes a slide deck: removes its folder from the classroom's content repo " +
    'on GitHub, deletes the database record, and refreshes the content manifest. This cannot ' +
    'be undone. Shared themes the deck used are kept, and any Cloudinary-hosted slide videos ' +
    'are NOT removed (delete those from the web app). OWNER/TEACHER may delete any deck; an ' +
    'ASSISTANT only decks they created or decks with allow_team_edit.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(slide, ctx);

    // Orchestrated delete. Cloudinary video cleanup is an app-local concern
    // (the service takes an optional onDeleteVideos callback the web app
    // provides); MCP has no cloudinary client, so videos are left in place
    // and the response says so.
    const result = await slideService.deleteSlide({ slideId: slide.id });

    await writeAudit(ctx, {
      resource_type: 'SLIDES',
      resource_id: slide.id,
      action: 'DELETE',
      data: {
        tool: 'slide_delete',
        title: slide.title,
        ...(result.themeName ? { shared_theme: result.themeName } : {}),
        video_cleanup: 'skipped',
      } as Prisma.InputJsonValue,
    });

    return ok({
      success: true,
      deleted: { id: slide.id, title: slide.title },
      ...(result.themeName ? { shared_theme: { name: result.themeName, deleted: false } } : {}),
      note: 'Cloudinary-hosted slide videos (if any) were not removed — delete them from the web app.',
    });
  },
};
