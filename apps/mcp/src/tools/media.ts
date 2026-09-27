/**
 * Media and agent-upload tools (media plan §9.8, §10.2, §11.5):
 *
 *   media_list          — a classroom's finished media (read).
 *   media_delete        — delete one media object (destructive).
 *   file_upload_start   — open a staged upload: one presigned PUT for `curl -T`.
 *   file_upload_finish  — verify the staged bytes and place them.
 *   file_upload_status  — placing | placed (ref) | failed (error).
 *   file_import_url     — fetch a URL server-side (SSRF-safe) and place it.
 *
 * Bytes never pass through the model. `page_asset_upload` (base64) stays for
 * small generated files; everything else goes through a staging key in the
 * media bucket and is then placed where the storage router sends it — the
 * page's or deck's folder in the content repo, or media on Pro. The protocol,
 * the row states and every check live in `mediaStaging.service.ts`; these
 * handlers resolve the target, apply the edit sub-gates the web applies to the
 * same page or deck, map refusals, and audit.
 *
 * Tier: TEACHING_TEAM (the web media routes' gate), with the target's own edit
 * gate on top — a page is OWNER/TEACHER (page editing), a deck is the slide
 * sub-gate (`assertSlideEditable`). finish/status are bound to the user who
 * opened the upload by the service, so they need no target check of their own.
 */

import { ClassmojiService } from '@classmoji/services';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  assertSlideEditable,
  holdsRole,
  loadPageWithRepoInClassroom,
  loadSlideInClassroom,
  ok,
  requireClassroomCtx,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");

/**
 * A media-service refusal → the ToolError an agent can act on. Codes pass
 * through so a client can switch on them; the message is the service's own
 * sentence. Anything that is not a `MediaError` is rethrown for the registry's
 * generic handling.
 */
function mediaToolError(error: unknown): never {
  if (ClassmojiService.media.isMediaError(error)) {
    const kind =
      error.code === 'NOT_FOUND'
        ? 'not_found'
        : error.code === 'PRO_REQUIRED'
          ? 'forbidden'
          : error.code === 'STAGE_LIMIT'
            ? 'rate_limited'
            : error.code === 'NOT_CONFIGURED'
              ? 'internal'
              : 'invalid_params';
    const data =
      error.code === 'QUOTA_EXCEEDED'
        ? { used_bytes: error.usedBytes, quota_bytes: error.quotaBytes }
        : undefined;
    throw new ToolError(
      kind,
      error.code === 'NOT_CONFIGURED'
        ? 'File uploads are not available on this deployment.'
        : error.message,
      error.code,
      data
    );
  }
  throw error;
}

async function callMedia<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return mediaToolError(error);
  }
}

/**
 * Exactly one of page_id / slide_id, loaded in THIS classroom (S1), with the
 * edit gate the web applies to it. Returns the staging target and the
 * classroom record the router reads (delivery fields included).
 */
async function resolveTarget(
  args: { page_id?: string; slide_id?: string },
  ctx: ToolContext
): Promise<{
  target: { type: 'page' | 'slide'; id: string };
  classroom: { id: string; [key: string]: unknown };
}> {
  if (Boolean(args.page_id) === Boolean(args.slide_id)) {
    throw new ToolError('invalid_params', 'Pass exactly one of page_id or slide_id');
  }
  if (args.page_id) {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);
    if (!(await holdsRole(ctx, ['OWNER', 'TEACHER']))) {
      throw new ToolError(
        'forbidden',
        'Only owners and teachers can add files to pages',
        'INSUFFICIENT_ROLE'
      );
    }
    return {
      target: { type: 'page', id: page.id },
      classroom: page.classroom as unknown as { id: string },
    };
  }
  const slide = await loadSlideInClassroom(args.slide_id!, ctx);
  await assertSlideEditable(slide, ctx);
  return { target: { type: 'slide', id: slide.id }, classroom: slide.classroom };
}

/** The status payload every upload tool answers with, in snake_case. */
function statusPayload(
  status: Awaited<ReturnType<typeof ClassmojiService.media.stagedUploadStatus>>
) {
  return {
    upload_id: status.uploadId,
    status: status.status,
    filename: status.filename,
    destination: status.destination,
    ...(status.status === 'placed' ? { ref: status.ref } : {}),
    ...(status.status === 'failed' ? { error: status.error } : {}),
    ...(status.status === 'placing' || status.status === 'awaiting_upload'
      ? { next: 'Poll file_upload_status with this upload_id.' }
      : {}),
  };
}

// ─── media_list ──────────────────────────────────────────────────────────────

interface MediaListArgs {
  classroom: string;
  kind?: 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'ARCHIVE' | 'IMAGE' | 'OTHER';
}

export const mediaListTool: ToolDefinition<MediaListArgs> = {
  name: 'media_list',
  title: "List a class's media",
  description:
    "Lists the class's finished media files (large files stored outside the course repo, " +
    'mostly Pro videos), newest first, up to 200. Each has a `ref` (media://…) to put in page ' +
    'or deck content, e.g. a video block. Optional kind filter. Uploads still in progress ' +
    'are not listed.',
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    kind: z
      .enum(['VIDEO', 'AUDIO', 'DOCUMENT', 'ARCHIVE', 'IMAGE', 'OTHER'])
      .optional()
      .describe('Only this kind'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const items = await ClassmojiService.media.listReadyMedia(classroomId, {
      ...(args.kind ? { kind: args.kind } : {}),
    });
    return ok({
      media: items.map(item => ({
        id: item.id,
        ref: item.ref,
        filename: item.filename,
        kind: item.kind,
        size_bytes: item.sizeBytes,
        created_at: item.createdAt,
      })),
    });
  },
};

// ─── media_delete ────────────────────────────────────────────────────────────

interface MediaDeleteArgs {
  classroom: string;
  media_id: string;
}

export const mediaDeleteTool: ToolDefinition<MediaDeleteArgs> = {
  name: 'media_delete',
  annotations: { destructive: true, idempotent: true, openWorld: false },
  rateLimit: { capacity: 10, refillPerSecond: 0.2 },
  title: 'Delete a media file',
  description:
    'Permanently deletes one media file (media_id from media_list). There is no undo: content ' +
    'that still references its media:// ref shows a missing-file placeholder. Deleting an ' +
    'already-deleted file succeeds again.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    media_id: z.string().uuid().describe('Media id (from media_list)'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const result = await callMedia(() =>
      ClassmojiService.media.deleteMedia({
        classroom: { id: classroomId },
        mediaId: args.media_id,
        // An agent upload still staging is its uploader's to delete.
        userId: ctx.viewer.userId,
      })
    );
    await writeAudit(ctx, {
      resource_type: 'MEDIA',
      resource_id: result.mediaId,
      action: 'DELETE',
      data: { tool: 'media_delete' } as Prisma.InputJsonValue,
    });
    return ok({ success: true, media_id: result.mediaId, deleted: true });
  },
};

// ─── file_upload_start ───────────────────────────────────────────────────────

interface FileUploadStartArgs {
  classroom: string;
  page_id?: string;
  slide_id?: string;
  filename: string;
  size: number;
}

export const fileUploadStartTool: ToolDefinition<FileUploadStartArgs> = {
  name: 'file_upload_start',
  annotations: { destructive: false, idempotent: false, openWorld: true },
  rateLimit: { capacity: 10, refillPerSecond: 0.1 },
  title: 'Start a file upload',
  description:
    'Starts uploading a local file to a page or slide deck without sending its bytes through ' +
    'the conversation. Give the exact size in bytes. Returns upload_url and a curl command: ' +
    "run `curl -T <file> '<upload_url>'` (a single PUT; the URL expires in 10 minutes and " +
    'only accepts exactly `size` bytes), then call file_upload_finish with upload_id. Where the ' +
    'file goes is decided here: small files go into the page/deck folder in the course repo; ' +
    'on Pro, videos and files over the repo limit go to media. A file the class cannot store ' +
    'is refused before you upload. For a file at a public https URL, use file_import_url.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    page_id: z.string().uuid().optional().describe('Page to add the file to'),
    slide_id: z.string().uuid().optional().describe('Slide deck to add the file to'),
    filename: z
      .string()
      .min(1)
      .max(200)
      .describe('File name WITH its extension (decides the type), without folders'),
    size: z.number().int().positive().describe('Exact file size in bytes'),
  },
  handler: async (args, ctx) => {
    const { target, classroom } = await resolveTarget(args, ctx);
    const started = await callMedia(() =>
      ClassmojiService.media.startStagedUpload({
        classroom,
        userId: ctx.viewer.userId,
        filename: args.filename,
        sizeBytes: args.size,
        target,
      })
    );
    await writeAudit(ctx, {
      resource_type: 'MEDIA',
      resource_id: started.uploadId,
      action: 'CREATE',
      data: {
        tool: 'file_upload_start',
        target_type: target.type,
        target_id: target.id,
        filename: args.filename,
        size: args.size,
        destination: started.destination,
      } as Prisma.InputJsonValue,
    });
    return ok({
      upload_id: started.uploadId,
      upload_url: started.uploadUrl,
      expires_at: started.expiresAt,
      destination: started.destination,
      size: started.sizeBytes,
      curl: `curl -T <file> '${started.uploadUrl}'`,
      next: 'After the PUT succeeds, call file_upload_finish with upload_id.',
    });
  },
};

// ─── file_upload_finish ──────────────────────────────────────────────────────

interface UploadIdArgs {
  classroom: string;
  upload_id: string;
}

export const fileUploadFinishTool: ToolDefinition<UploadIdArgs> = {
  name: 'file_upload_finish',
  annotations: { destructive: false, idempotent: true, openWorld: true },
  rateLimit: { capacity: 10, refillPerSecond: 0.2 },
  title: 'Finish a file upload',
  description:
    'Finishes an upload started with file_upload_start, after the curl PUT succeeded. Checks the ' +
    'uploaded size, then places the file. A media file returns status "placed" with its ref ' +
    '(media://…) at once. A course-repo file returns "placing" — poll file_upload_status until ' +
    'it is "placed" (ref = the repo path to use in content) or "failed". Safe to call again.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    upload_id: z.string().uuid().describe('upload_id from file_upload_start'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const status = await callMedia(() =>
      ClassmojiService.media.finishStagedUpload({
        classroom: { id: classroomId },
        userId: ctx.viewer.userId,
        uploadId: args.upload_id,
      })
    );
    await writeAudit(ctx, {
      resource_type: 'MEDIA',
      resource_id: args.upload_id,
      action: 'UPDATE',
      data: {
        tool: 'file_upload_finish',
        status: status.status,
        ...(status.status === 'placed' ? { ref: status.ref } : {}),
      } as Prisma.InputJsonValue,
    });
    return ok(statusPayload(status));
  },
};

// ─── file_upload_status ──────────────────────────────────────────────────────

export const fileUploadStatusTool: ToolDefinition<UploadIdArgs> = {
  name: 'file_upload_status',
  title: 'Check a file upload',
  description:
    'Reports an upload from file_upload_start or file_import_url: "awaiting_upload" (PUT not ' +
    'finished yet), "placing", "placed" with `ref` (the reference to put in page or deck ' +
    'content), or "failed" with `error`. Poll every few seconds while placing.',
  scope: 'read',
  roles: TEACHING_TEAM,
  rateLimit: { capacity: 30, refillPerSecond: 1 },
  inputSchema: {
    classroom: classroomArg,
    upload_id: z.string().uuid().describe('upload_id from file_upload_start or file_import_url'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const status = await callMedia(() =>
      ClassmojiService.media.stagedUploadStatus({
        classroom: { id: classroomId },
        userId: ctx.viewer.userId,
        uploadId: args.upload_id,
      })
    );
    return ok(statusPayload(status));
  },
};

// ─── file_import_url ─────────────────────────────────────────────────────────

interface FileImportUrlArgs {
  classroom: string;
  page_id?: string;
  slide_id?: string;
  url: string;
  filename?: string;
}

export const fileImportUrlTool: ToolDefinition<FileImportUrlArgs> = {
  name: 'file_import_url',
  annotations: { destructive: false, idempotent: false, openWorld: true },
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  title: 'Import a file from a URL',
  description:
    'Adds a file at a public https URL to a page or slide deck: the server downloads it and ' +
    'places it like file_upload_start would (course repo for small files; media on Pro for ' +
    'videos and large files). For agents without a shell. The URL must be https on port 443, ' +
    'with no login, redirects or private addresses; size is capped by the class plan (the ' +
    'repo limit on Free, 2 GB on Pro). Returns upload_id with status "placing" — poll ' +
    'file_upload_status for the ref. Pass filename if the URL does not end in one.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    page_id: z.string().uuid().optional().describe('Page to add the file to'),
    slide_id: z.string().uuid().optional().describe('Slide deck to add the file to'),
    url: z
      .string()
      .url()
      .max(4096)
      .describe('Public https URL of the file (the final URL, no redirects)'),
    filename: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('File name WITH extension; defaults to the last segment of the URL'),
  },
  handler: async (args, ctx) => {
    const { target, classroom } = await resolveTarget(args, ctx);
    const started = await callMedia(() =>
      ClassmojiService.media.startUrlImport({
        classroom,
        userId: ctx.viewer.userId,
        url: args.url,
        filename: args.filename ?? null,
        target,
      })
    );
    await writeAudit(ctx, {
      resource_type: 'MEDIA',
      resource_id: started.uploadId,
      action: 'CREATE',
      data: {
        tool: 'file_import_url',
        target_type: target.type,
        target_id: target.id,
        url: args.url,
        filename: started.filename,
      } as Prisma.InputJsonValue,
    });
    return ok({
      upload_id: started.uploadId,
      status: 'placing',
      filename: started.filename,
      max_bytes: started.maxBytes,
      next: 'Poll file_upload_status with this upload_id.',
    });
  },
};

export const mediaTools = [
  mediaListTool,
  mediaDeleteTool,
  fileUploadStartTool,
  fileUploadFinishTool,
  fileUploadStatusTool,
  fileImportUrlTool,
] as const;
