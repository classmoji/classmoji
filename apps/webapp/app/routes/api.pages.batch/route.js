import { assertClassroomAccess } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import { processMarkdownImport } from '~/utils/markdownImporter.server';
import { wrapHtmlContent } from '~/utils/htmlWrapper';

/**
 * API route for batch page imports - always returns JSON
 */
export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = formData.get('intent');
  const classSlug = formData.get('classSlug');
  const term = formData.get('term');

  const { classroom, userId } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });

  // Use git_organization.login for GitHub API calls, not the classroom slug
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return Response.json({ error: 'Git organization not configured' });
  }

  // Initialize batch import - creates repo if needed
  if (intent === 'batch-init') {
    const repoName = `content-${gitOrgLogin}-${term}`;
    const gitProvider = getGitProvider(classroom.git_organization);

    const repoExists = await gitProvider.repositoryExists(gitOrgLogin, repoName);
    if (!repoExists) {
      try {
        await gitProvider.createPublicRepository(
          gitOrgLogin,
          repoName,
          `Course content for ${classroom.name || gitOrgLogin} - ${term}`
        );
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (repoError) {
        console.error('Failed to create GitHub repository:', repoError);
        return Response.json({
          error:
            'Failed to create GitHub repository. Please check your GitHub organization permissions',
        });
      }
    }

    // Try to enable GitHub Pages
    try {
      await gitProvider.enableGitHubPages(gitOrgLogin, repoName);
    } catch (pagesError) {
      console.warn(`Could not auto-enable GitHub Pages: ${pagesError.message}`);
    }

    return Response.json({ initialized: true, repoName });
  }

  // Import a single page
  if (intent === 'batch-import-single') {
    const title = formData.get('title');
    const moduleId = formData.get('assignmentId') || null; // Optional - for linking
    const repoName = `content-${gitOrgLogin}-${term}`;

    try {
      // Generate slug from title
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // Flat content path: pages/{slug}
      const contentPath = `pages/${slug}`;
      const assetsFolder = `${contentPath}/assets`;

      // Get markdown and images
      const markdownFile = formData.get('markdown');
      const imageFiles = formData.getAll('images');

      const markdownText = await markdownFile.text();

      // Process markdown and images
      const { html, imageMap, unmatchedImages } = await processMarkdownImport(
        markdownText,
        imageFiles,
        { org: gitOrgLogin, repo: repoName, contentPath, assetsFolder }
      );

      // Prepare files to upload
      const filesToUpload = [];

      // Add all matched images
      imageMap.forEach(imageInfo => {
        filesToUpload.push({
          path: imageInfo.newPath,
          content: imageInfo.file,
          encoding: 'binary',
        });
      });

      // Add unmatched images
      unmatchedImages.forEach(file => {
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
      const uploadFiles = await Promise.all(
        filesToUpload.map(async file => ({
          path: file.path,
          content: Buffer.from(await file.content.arrayBuffer()).toString('base64'),
          encoding: 'base64',
        }))
      );

      // Wrap HTML content
      const wrappedHtml = wrapHtmlContent(html, 2);

      // Add HTML content
      uploadFiles.push({
        path: `${contentPath}/index.html`,
        content: wrappedHtml,
        encoding: 'utf-8',
      });

      // Upload all files in a single batch
      if (uploadFiles.length > 0) {
        await ContentService.uploadBatch({
          gitOrganization: classroom.git_organization,
          repo: repoName,
          files: uploadFiles,
          branch: 'main',
          message: `Import page: ${title}`,
        });
      }

      // Create the database record
      const page = await ClassmojiService.page.create({
        classroom_id: classroom.id,
        title,
        content_path: contentPath,
        created_by: userId,
      });

      // Link to module if specified
      if (moduleId) {
        await ClassmojiService.page.linkPage(page.id, { moduleId });
      }

      // Update manifest after creating page
      await ClassmojiService.contentManifest.saveManifest(classroom.id);

      return Response.json({ created: true, page });
    } catch (error) {
      console.error(`Failed to import page "${title}":`, error);
      return Response.json({ error: error.message });
    }
  }

  return Response.json({ error: 'Invalid intent' }, { status: 400 });
};
