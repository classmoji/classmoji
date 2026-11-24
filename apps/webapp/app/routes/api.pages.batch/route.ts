import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import {
  PAGE_IMPORT_TOO_LARGE_MESSAGE,
  oversizedImportFileMessage,
  readPageImportForm,
} from '~/utils/pageImportBody.server';
import { markdownImportFiles } from '~/utils/pageImportFiles.server';
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
    return Response.json({ error: 'No Github organization or Gitlab group configured' });
  }

  // Stored, user-editable content repo name. Never re-derive it.
  const contentRepo = classroom.content_repo;
  if (!contentRepo) {
    return Response.json({ error: 'Classroom content repo not configured' });
  }

  // Every page of a batch converts on Trigger.dev; without it the drawer does
  // not offer Batch Import, and a post here anyway is refused before the
  // content repo is touched.
  if (
    (intent === 'batch-init' || intent === 'batch-import-single') &&
    !ClassmojiService.pageImport.isPageImportAvailable()
  ) {
    return Response.json({ error: ClassmojiService.pageImport.PAGE_IMPORT_MESSAGES.unavailable });
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
      const contentPath = await ClassmojiService.page.freePageContentPath(classroom.id, title);
      const assetsFolder = `${contentPath}/assets`;

      // Get markdown and images
      const markdownFile = formData.get('markdown') as File;
      const imageFiles = formData
        .getAll('images')
        .filter((file): file is File => typeof file !== 'string');

      // One commit carries the page and every image, so one image over the
      // repository's cap is refused here, by name, before anything is written.
      const oversized = oversizedImportFileMessage(imageFiles);
      if (oversized) return Response.json({ error: oversized });

      const markdownText = await markdownFile.text();

      // The checks createPage would refuse this page with (page limit, a title
      // whose path is taken, a repository outside the classroom), before a run
      // is spent on the conversion; same errors, so the same failure row.
      // A title the conversion would refuse is refused first, with a sentence.
      ClassmojiService.pageImport.assertImportTitle(title);
      await ClassmojiService.page.preflightCreatePage({
        classroomId: classroom.id,
        title,
        linkRepositoryId: moduleId,
      });

      // Markdown -> blocks on Trigger.dev, which sees the images' names only
      // and says where each goes. A conversion that fails or times out throws
      // a PageImportError whose message lands in the batch's failure list;
      // nothing is created for this page.
      const conversion = await ClassmojiService.pageImport.convertMarkdown({
        markdown: markdownText,
        title,
        imageNames: imageFiles.map(file => file.name),
        options: {
          org: gitOrgLogin,
          repo: contentRepo,
          contentPath,
          assetsFolder,
          provider: classroom.git_organization?.provider,
        },
      });
      const uploadFiles = await markdownImportFiles(conversion, imageFiles, contentPath);

      // Orchestrated create: upload (content.json + assets) + DB row + optional
      // repository link + manifest refresh (packages/services page.createPage).
      // ensureRepo: false — batch-init already created the content repo.
      const page = await ClassmojiService.page.createPage({
        classroomId: classroom.id,
        title,
        blocks: conversion.blocks,
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
