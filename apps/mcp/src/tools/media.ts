/**
 * Media and agent-upload tools (media plan §9.8, §10.2, §11.5):
 *
 *   media_list          — a classroom's finished media (read).
 *   media_delete        — delete one media object (destructive).
 *   file_upload_start   — open a staged upload: one presigned PUT for `curl -T`.
 *   file_upload_finish  — verify the staged bytes and place them.
 *   file_upload_status  — placing | placed (ref) | failed (error).
 *   file_import_url     — fetch a URL server-side (SSRF-safe) and place it.
 *   file_download_url   — a ten-minute signed GET for one file, for `curl -o` (read).
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
 *
 * file_download_url takes the READ gates of the same content instead: a page
 * file is page_content_get's OWNER/TEACHER (the raw page, locked bodies
 * included), a deck file is deck_get's teaching team, a media file is
 * media_list's. Staff only, so locked sections and drafts need no rule of
 * their own. It signs through the delivery layer's `download` tier (the
 * Worker's existing blob and media routes), and like the other content reads
 * it writes no audit row.
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
  scopedNotFound,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");

/** A slide deck's subfolder for an upload (validated by the media service). */
const folderArg = z
  .string()
  .min(1)
  .max(160)
  .optional()
  .describe(
    'Slide decks only: a folder inside the deck (e.g. games/minions, ≤4 levels, letters, ' +
      'digits . _ -). The file is stored there under exactly its filename, replacing an older ' +
      'copy, so files that load each other by relative path work. Omit for single images'
  );

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
    'are not listed. `size_bytes` is what the file costs the class: the streaming copy once ' +
    'the original is not kept. `processing` is read-only: NONE (not optimised), PENDING (a streaming ' +
    'copy is being made), DONE (the streaming copy is served), FAILED (the original is ' +
    'served; `processing_error` says why).',
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
        processing: item.processing,
        ...(item.processingError ? { processing_error: item.processingError } : {}),
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
  folder?: string;
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
    'is refused before you upload. For a file at a public https URL, use file_import_url. ' +
    'A multi-file game or demo for a deck: upload each file with slide_id + the same folder, ' +
    'then deck_apply block_add type html with src = the html file ref; a one-file piece can ' +
    'go in as the html block source instead.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    page_id: z.string().uuid().optional().describe('Page to add the file to'),
    slide_id: z.string().uuid().optional().describe('Slide deck to add the file to'),
    folder: folderArg,
    filename: z
      .string()
      .min(1)
      .max(200)
      .describe('File name WITH its extension (decides the type); folders go in folder'),
    size: z.number().int().positive().describe('Exact file size in bytes'),
  },
  handler: async (args, ctx) => {
    const { target, classroom } = await resolveTarget(args, ctx);
    const started = await callMedia(() =>
      ClassmojiService.media.startStagedUpload({
        classroom,
        userId: ctx.viewer.userId,
        filename: args.filename,
        ...(args.folder !== undefined ? { folder: args.folder } : {}),
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
        ...(args.folder !== undefined ? { folder: args.folder } : {}),
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
  folder?: string;
  url: string;
  filename?: string;
}

/** A URL as the audit log records it: scheme, host and path only. Exported for tests. */
export function auditableUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw.split(/[?#]/)[0];
  }
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
    'repo limit on Free, 2 GB on Pro). Large files need a reasonably fast host: the download ' +
    'must finish within about 13 minutes. Returns upload_id with status "placing" — poll ' +
    'file_upload_status for the ref. Pass filename if the URL does not end in one.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    page_id: z.string().uuid().optional().describe('Page to add the file to'),
    slide_id: z.string().uuid().optional().describe('Slide deck to add the file to'),
    folder: folderArg,
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
        ...(args.folder !== undefined ? { folder: args.folder } : {}),
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
        // Without its query string or fragment: a pre-signed download link
        // carries its credential there, and the audit log is not the place
        // to keep one.
        url: auditableUrl(args.url),
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

// ─── file_download_url ───────────────────────────────────────────────────────

interface FileDownloadUrlArgs {
  classroom: string;
  page_id?: string;
  slide_id?: string;
  media_id?: string;
  path?: string;
}

/**
 * The repo path an agent asked for, inside `folder`, or null. Exported for
 * tests; `contentDelivery.repoPathInFolder` applies the same rule again in the
 * service.
 *
 * `path` is either the repo path content stores (`pages/lab-1/assets/x.png`)
 * or a path relative to the page's or deck's own folder (`assets/x.png`); one
 * whose first segment is the content root's (`pages`, `slides`) is read as a
 * repo path, so another page's or deck's path is refused, not re-rooted.
 * Anything that is not a plain relative path is refused, not repaired: a
 * leading `/`, a backslash, a scheme (`media://`, `https:`), a query or
 * fragment, a control character, a `..` segment. The result must lie strictly
 * inside `folder`.
 */
export function downloadPathFor(contentPath: string, folder: string, path: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\?#\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  const clean = (value: string) => value.split('/').filter(part => part && part !== '.');
  const parts = clean(path);
  if (parts.length === 0 || parts.includes('..')) return null;
  const base = clean(contentPath);
  const inside = clean(folder);
  if (base.length === 0 || inside.length === 0) return null;
  const startsWith = (list: string[], prefix: string[]) =>
    prefix.every((part, index) => list[index] === part);
  // A path that starts where the content root does (`pages/…`, `slides/…`) is
  // a repo path and must name this folder; anything else is relative to it.
  const full = parts[0] === base[0] ? parts : [...base, ...parts];
  if (!startsWith(full, inside) || full.length <= inside.length) return null;
  return full.join('/');
}

/** Unix seconds out of a signed URL's `exp`, as an ISO time; null if absent. */
function expiresAtOf(url: string): string | null {
  const exp = Number(new URL(url).searchParams.get('exp'));
  return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null;
}

/** The filename a signed URL's `dl` carries (what the download is saved as). */
function signedFilenameOf(url: string): string | null {
  const dl = new URL(url).searchParams.get('dl');
  if (!dl) return null;
  try {
    return Buffer.from(dl, 'base64url').toString('utf8') || null;
  } catch {
    return null;
  }
}

function downloadPayload(fields: {
  url: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  expires_at: string | null;
  [key: string]: unknown;
}) {
  // Single quotes around both: a signed query has `&`, and a name may have spaces.
  const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const { url, ...rest } = fields;
  return {
    download_url: url,
    ...rest,
    curl: `curl -fL -o ${quoted(fields.filename)} ${quoted(url)}`,
  };
}

const NO_SIGNED_DOWNLOADS =
  'Signed downloads are not available for this class: its files are not served through ' +
  "Classmoji's content delivery.";

export const fileDownloadUrlTool: ToolDefinition<FileDownloadUrlArgs> = {
  name: 'file_download_url',
  annotations: { openWorld: false },
  rateLimit: { capacity: 30, refillPerSecond: 0.5 },
  title: 'Get a file download link',
  description:
    'Returns a short-lived signed download_url for one course file, so you can save it to disk ' +
    'with the returned curl line (`curl -fL -o <name> <url>`) instead of reading its bytes into ' +
    'the conversation. The counterpart of file_upload_start / file_upload_finish. Pass exactly ' +
    'one of: page_id + path (a file in the page’s assets folder), slide_id + path (a file in ' +
    'the deck’s folder), or media_id (from media_list or a media:// ref). path is the repo path ' +
    'stored in content (pages/lab-1/assets/x.png) or one relative to the page or deck folder ' +
    '(assets/x.png). Returns expires_at (the URL stops working after about 10 minutes; ask ' +
    'again for a new one), filename, size_bytes and content_type when known. Staff only: pages ' +
    'for owners and teachers, decks and media for the teaching team; drafts included.',
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    page_id: z.string().uuid().optional().describe('Page whose assets folder holds the file'),
    slide_id: z.string().uuid().optional().describe('Slide deck whose folder holds the file'),
    media_id: z.string().uuid().optional().describe('Media id (from media_list)'),
    path: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('With page_id or slide_id: the file’s repo path, or one relative to that folder'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const targets = [args.page_id, args.slide_id, args.media_id].filter(Boolean);
    if (targets.length !== 1) {
      throw new ToolError('invalid_params', 'Pass exactly one of page_id, slide_id or media_id');
    }

    if (args.media_id) {
      if (args.path !== undefined) {
        throw new ToolError('invalid_params', 'path goes with page_id or slide_id, not media_id');
      }
      // Scoped to this classroom and to READY in the query: another class's id
      // is simply absent, the same answer as one that never existed.
      const record = (
        await ClassmojiService.media.lookupReadyMedia(classroomId, [args.media_id])
      ).get(args.media_id);
      if (!record || record.classroomId !== classroomId) throw scopedNotFound('Media file');
      const url = await ClassmojiService.contentDelivery.mediaDownloadUrl({
        classroom: requireClassroomCtx(ctx).classroom as never,
        record,
        // Staff always get the file, whatever the uploader chose for students.
        forStudent: false,
      });
      if (!url) {
        throw new ToolError('invalid_params', NO_SIGNED_DOWNLOADS, 'DOWNLOADS_UNAVAILABLE');
      }
      const isOriginal = new URL(url).pathname.split('/').pop()?.startsWith('orig.') ?? true;
      return ok(
        downloadPayload({
          url,
          media_id: record.id,
          filename: signedFilenameOf(url) ?? record.filename,
          content_type: isOriginal ? record.contentType : 'video/mp4',
          size_bytes: isOriginal ? record.sizeBytes : (record.renditionBytes ?? null),
          expires_at: expiresAtOf(url),
        })
      );
    }

    if (args.path === undefined) {
      throw new ToolError('invalid_params', 'path is required with page_id or slide_id');
    }

    let target: { content_path: string; classroom: unknown; folder: string; what: string };
    if (args.page_id) {
      const page = await loadPageWithRepoInClassroom(args.page_id, ctx);
      // page_content_get's tier: the raw page, locked bodies and all, is for
      // owners and teachers.
      if (!(await holdsRole(ctx, ['OWNER', 'TEACHER']))) {
        throw new ToolError(
          'forbidden',
          'Only owners and teachers can download files from pages',
          'INSUFFICIENT_ROLE'
        );
      }
      target = {
        content_path: page.content_path,
        classroom: page.classroom,
        folder: `${page.content_path}/assets`,
        what: 'the page’s assets folder',
      };
    } else {
      // deck_get's tier: reading a deck is a teaching-team right; no edit gate.
      const slide = await loadSlideInClassroom(String(args.slide_id), ctx);
      target = {
        content_path: slide.content_path,
        classroom: slide.classroom,
        folder: slide.content_path,
        what: 'the deck’s folder',
      };
    }

    const path = downloadPathFor(target.content_path, target.folder, args.path);
    if (!path) {
      throw new ToolError(
        'invalid_params',
        `path must be a file inside ${target.what} (no "..", no leading "/", no URL)`,
        'BAD_PATH'
      );
    }

    const result = await ClassmojiService.contentDelivery.resolveRepoFileDownloadUrl(
      target.classroom as never,
      { folder: target.folder, path }
    );
    if (!result.ok) {
      if (result.reason === 'bad_path') {
        throw new ToolError(
          'invalid_params',
          `path must be a file inside ${target.what}`,
          'BAD_PATH'
        );
      }
      if (result.reason === 'delivery_off') {
        throw new ToolError('invalid_params', NO_SIGNED_DOWNLOADS, 'DOWNLOADS_UNAVAILABLE');
      }
      if (result.reason === 'not_in_map') {
        throw new ToolError('not_found', `No file at ${path} in ${target.what}`);
      }
      throw new ToolError('internal', 'This file cannot be offered as a download');
    }

    return ok(
      downloadPayload({
        url: result.url,
        path: result.path,
        filename: result.filename,
        content_type: null,
        size_bytes: result.sizeBytes,
        expires_at: new Date(result.expiresAt * 1000).toISOString(),
      })
    );
  },
};

export const mediaTools = [
  mediaListTool,
  mediaDeleteTool,
  fileUploadStartTool,
  fileUploadFinishTool,
  fileUploadStatusTool,
  fileImportUrlTool,
  fileDownloadUrlTool,
] as const;
