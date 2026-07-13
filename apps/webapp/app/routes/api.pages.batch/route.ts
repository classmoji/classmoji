import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { processMarkdownImport } from '~/utils/markdownImporter.server';
import { wrapHtmlContent } from '~/utils/htmlWrapper';
import type { Route } from './+types/route';

/**
 * API route for batch page imports - always returns JSON
 */
export const action = async ({ request }: Route.ActionArgs) => {
  const formData = await request.formData();
  const intent = formData.get('intent') as string;
  const classSlug = formData.get('classSlug') as string;
  const { classroom, userId, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // Use git_organization.login for GitHub API calls, not the classroom slug
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return Response.json({ error: 'Git organization not configured' });
  }

  const contentNamespace = classroom.content_namespace;
  if (!contentNamespace) {
    return Response.json({ error: 'Classroom content namespace not configured' });
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
    const repoName = `content-${gitOrgLogin}-${contentNamespace}`;

    try {
      // Flat content path: pages/{slug}
      const contentPath = ClassmojiService.page.pageContentPath(title);
      const assetsFolder = `${contentPath}/assets`;

      // Get markdown and images
      const markdownFile = formData.get('markdown') as File;
      const imageFiles = formData.getAll('images') as File[];

      const markdownText = await markdownFile.text();

      // Process markdown and images
      const { html, imageMap, unmatchedImages } = await processMarkdownImport(
        markdownText,
        imageFiles,
        { org: gitOrgLogin, repo: repoName, contentPath, assetsFolder }
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

      return Response.json({ created: true, page });
    } catch (error: unknown) {
      console.error(`Failed to import page "${title}":`, error);
      return Response.json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  return Response.json({ error: 'Invalid intent' }, { status: 400 });
};
