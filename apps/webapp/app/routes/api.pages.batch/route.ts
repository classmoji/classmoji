import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { processMarkdownImport } from '~/utils/markdownImporter.server';
import {
  PAGE_IMPORT_TOO_LARGE_MESSAGE,
  oversizedImportFileMessage,
  readPageImportForm,
} from '~/utils/pageImportBody.server';
import { wrapHtmlContent } from '~/utils/htmlWrapper';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_RETRY_AFTER_SECONDS,
  acquireUploadSlot,
  releaseUploadSlot,
} from '@classmoji/utils/upload-concurrency';
import type { Route } from './+types/route';

/**
 * API route for batch page imports - always returns JSON
 *
 * POST /api/pages/batch?classSlug=<slug>
 *
 * The classroom is named in the QUERY STRING so the gate runs before the body
 * is read; the body is then read with a cap (see `pageImportBody.server`).
 */
export const action = async (args: Route.ActionArgs) => {
  // The import takes an upload slot partway through — after the gate, before
  // the body is read — and this gives it back however the request ends.
  const slot = { held: false };
  try {
    return await batchAction(args, slot);
  } finally {
    if (slot.held) releaseUploadSlot();
  }
};

async function batchAction({ request }: Route.ActionArgs, slot: { held: boolean }) {
  const classSlug = new URL(request.url).searchParams.get('classSlug');
  if (!classSlug) {
    return Response.json({ error: 'No classroom provided' }, { status: 400 });
  }
  const { classroom, userId, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // One slot per request in flight: the body cap bounds one page of a batch,
  // this bounds how many this process holds at once.
  if (!acquireUploadSlot()) {
    return Response.json(
      { error: UPLOAD_BUSY_MESSAGE },
      { status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }
    );
  }
  slot.held = true;

  const formData = await readPageImportForm(request);
  if (!formData) {
    return Response.json({ error: PAGE_IMPORT_TOO_LARGE_MESSAGE }, { status: 413 });
  }
  const intent = formData.get('intent') as string;

  // Use git_organization.login for GitHub API calls, not the classroom slug
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return Response.json({ error: 'Git organization not configured' });
  }

  // Stored, user-editable content repo name. Never re-derive it.
  const contentRepo = classroom.content_repo;
  if (!contentRepo) {
    return Response.json({ error: 'Classroom content repo not configured' });
  }

  // Initialize batch import - creates repo if needed
  if (intent === 'batch-init') {
    try {
      const { repoName } = await ClassmojiService.page.ensureContentRepo(classroom.id);
      return Response.json({ initialized: true, repoName });
    } catch (error: unknown) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Import a single page
  if (intent === 'batch-import-single') {
    const title = formData.get('title') as string;
    const moduleId = (formData.get('assignmentId') as string) || null; // Optional - for linking

    try {
      // Flat content path: pages/{slug}
      const contentPath = ClassmojiService.page.pageContentPath(title);
      const assetsFolder = `${contentPath}/assets`;

      // Get markdown and images
      const markdownFile = formData.get('markdown') as File;
      const imageFiles = formData.getAll('images') as File[];

      // One commit carries the page and every image, so one image over the
      // repository's cap is refused here, by name, before anything is written.
      const oversized = oversizedImportFileMessage(imageFiles);
      if (oversized) return Response.json({ error: oversized });

      const markdownText = await markdownFile.text();

      // Process markdown and images
      const { html, imageMap, unmatchedImages } = await processMarkdownImport(
        markdownText,
        imageFiles,
        { org: gitOrgLogin, repo: contentRepo, contentPath, assetsFolder }
      );

      // Prepare files to upload
      const filesToUpload: Array<{
        path: string;
        content: File;
        encoding: 'binary';
      }> = [];

      // Add all matched images
      imageMap.forEach(imageInfo => {
        filesToUpload.push({
          path: imageInfo.newPath,
          content: imageInfo.file,
          encoding: 'binary',
        });
      });

      // Add unmatched images (cast back to File since we know the inputs were File objects)
      (unmatchedImages as unknown as File[]).forEach(file => {
        const timestamp = Date.now();
        const sanitizedName = file.name
          .toLowerCase()
          .replace(/[^a-z0-9.-]/g, '-')
          .replace(/-+/g, '-');
        const newFilename = `${sanitizedName.split('.')[0]}-${timestamp}.${sanitizedName.split('.').pop()}`;
        const newPath = `${contentPath}/assets/${newFilename}`;

        filesToUpload.push({
          path: newPath,
          content: file,
          encoding: 'binary',
        });
      });

      // Convert File objects to buffers
      const uploadFiles: Array<{ path: string; content: string; encoding: 'base64' | 'utf-8' }> =
        await Promise.all(
          filesToUpload.map(async file => ({
            path: file.path,
            content: Buffer.from(await file.content.arrayBuffer()).toString('base64'),
            encoding: 'base64' as const,
          }))
        );

      // Wrap HTML content
      const wrappedHtml = wrapHtmlContent(html, 2);

      // Orchestrated create: upload (index.html + assets) + DB row + optional
      // repository link + manifest refresh (packages/services page.createPage).
      // ensureRepo: false — batch-init already created the content repo.
      const page = await ClassmojiService.page.createPage({
        classroomId: classroom.id,
        title,
        html: wrappedHtml,
        files: uploadFiles,
        createdBy: userId,
        linkRepositoryId: moduleId,
        ensureRepo: false,
        commitMessage: `Import page: ${title}`,
      });

      // The batch flow posts here once per page, so this is where batch page
      // creation is recorded — the admin.$class.pages.new action only handles
      // the single blank/import case. Same 'PAGES'/'CREATE' shape as that
      // action and as the MCP page_create tool.
      await addClassroomAuditLog({
        classroomId: classroom.id,
        userId,
        role: membership!.role,
        action: 'CREATE',
        resourceType: 'PAGES',
        resourceId: page.id,
        metadata: {
          tool: 'web:pages.create_batch',
          title,
          imported_files: uploadFiles.length,
          linked_repository_id: moduleId,
        },
      });

      return Response.json({ created: true, page });
    } catch (error: unknown) {
      console.error(`Failed to import page "${title}":`, error);
      return Response.json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  return Response.json({ error: 'Invalid intent' }, { status: 400 });
}
