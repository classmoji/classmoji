import { redirect } from 'react-router';
import { assertClassroomAccess } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import { wrapHtmlContent } from '~/utils/htmlWrapper';
import { processMarkdownImport, extractTitleFromMarkdown } from '~/utils/markdownImporter.server';
import { extractBodyContent } from './route';
import { generateTermString } from '@classmoji/utils';

// Action to handle save and upload operations
export const action = async ({ request, params }) => {
  const { class: classSlug, pageId } = params;

  // Check if this is a JSON request
  const contentType = request.headers.get('content-type');
  const isJson = contentType?.includes('application/json');

  // Get intent from URL query params
  const url = new URL(request.url);
  let intent = url.searchParams.get('intent');

  // Parse formData only for non-JSON requests
  let formData;
  if (!isJson && intent !== 'update-tags') {
    formData = await request.formData();
    // If no intent in URL, check formData
    if (!intent) {
      intent = formData.get('intent');
    }
  }

  if (intent === 'upload-image') {
    if (!formData) formData = await request.formData();
    try {
      const file = formData.get('file');

      console.error('[upload-image action] Received file:', file?.name || 'no file');
      if (!file || typeof file === 'string') {
        console.error('[upload-image action] Invalid file');
        return Response.json(
          { error: 'No file provided', intent: 'upload-image' },
          { status: 400 }
        );
      }

      // Wrap assertClassroomAccess in try-catch to ensure we always return JSON
      try {
        await assertClassroomAccess({
          request,
          classroomSlug: classSlug,
          allowedRoles: ['OWNER', 'TEACHER'],
          resourceType: 'PAGES',
          attemptedAction: 'upload_image',
        });
      } catch (authError) {
        console.error('[upload-image action] Authorization failed:', authError);
        return Response.json(
          { error: authError.message || 'Unauthorized to upload images', intent: 'upload-image' },
          { status: 403 }
        );
      }

      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: true,
      });

      if (!page) {
        console.error('[upload-image action] Page not found');
        return Response.json({ error: 'Page not found', intent: 'upload-image' }, { status: 404 });
      }

      const gitOrg = page.classroom.git_organization;
      const term = generateTermString(page.classroom.term, page.classroom.year);
      const repo = `content-${gitOrg.login}-${term}`;
      const assetsFolder = `${page.content_path}/assets`;

      console.error('[upload-image action] Uploading to repo:', repo, 'folder:', assetsFolder);
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await ContentService.upload({
        gitOrganization: gitOrg,
        repo,
        file: buffer,
        filename: file.name,
        folder: assetsFolder,
        message: `Upload image for ${page.title}`,
      });

      console.error('[upload-image action] Upload successful, URL:', result.url);
      return Response.json({
        success: true,
        url: result.url,
        path: result.path,
        intent: 'upload-image',
      });
    } catch (error) {
      console.error('[upload-image action] Upload failed:', error);
      return Response.json(
        {
          error: error.message || 'Failed to upload image',
          intent: 'upload-image',
        },
        { status: 500 }
      );
    }
  }

  if (intent === 'upload-file') {
    if (!formData) formData = await request.formData();
    try {
      const file = formData.get('file');

      if (!file || typeof file === 'string') {
        return Response.json({ error: 'No file provided', intent: 'upload-file' }, { status: 400 });
      }

      try {
        await assertClassroomAccess({
          request,
          classroomSlug: classSlug,
          allowedRoles: ['OWNER', 'TEACHER'],
          resourceType: 'PAGES',
          attemptedAction: 'upload_file',
        });
      } catch (authError) {
        console.log(authError);
        return Response.json(
          { error: authError.message || 'Unauthorized to upload files', intent: 'upload-file' },
          { status: 403 }
        );
      }

      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: true,
      });

      if (!page) {
        return Response.json({ error: 'Page not found', intent: 'upload-file' }, { status: 404 });
      }

      const gitOrg = page.classroom.git_organization;
      const term = generateTermString(page.classroom.term, page.classroom.year);
      const repo = `content-${gitOrg.login}-${term}`;
      const assetsFolder = `${page.content_path}/assets`;

      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await ContentService.upload({
        gitOrganization: gitOrg,
        repo,
        file: buffer,
        filename: file.name,
        folder: assetsFolder,
        message: `Upload file for ${page.title}`,
      });

      return Response.json({
        success: true,
        url: result.url,
        path: result.path,
        intent: 'upload-file',
      });
    } catch (error) {
      console.error('[upload-file action] Upload failed:', error);
      return Response.json(
        {
          error: error.message || 'Failed to upload file',
          intent: 'upload-file',
        },
        { status: 500 }
      );
    }
  }

  if (intent === 'delete') {
    await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'delete_page',
    });

    try {
      // Use deletePage to also delete from GitHub and update manifest
      await ClassmojiService.page.deletePage(pageId);
      // Redirect immediately to prevent loader revalidation on deleted page
      return redirect(`/admin/${classSlug}/pages?deleted=true`);
    } catch (error) {
      console.error('Failed to delete page:', error);
      return { error: error.message || 'Failed to delete page', intent: 'delete' };
    }
  }

  if (intent === 'update-width') {
    if (!formData) formData = await request.formData();
    const width = parseInt(formData.get('width'), 10);

    await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'update_width',
    });

    try {
      await ClassmojiService.page.quickUpdate(pageId, {
        width,
        updated_at: new Date(),
      });

      return { success: true, intent: 'update-width' };
    } catch (error) {
      console.error('Failed to update page width:', error);
      return { error: error.message || 'Failed to update page width', intent: 'update-width' };
    }
  }

  if (intent === 'toggleStudentMenu') {
    await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'toggle_student_menu',
    });

    try {
      const data = await request.json();
      await ClassmojiService.page.quickUpdate(pageId, {
        show_in_student_menu: data.show_in_student_menu,
      });
      return { success: true, intent: 'toggleStudentMenu' };
    } catch (error) {
      console.error('Failed to toggle student menu:', error);
      return { error: error.message || 'Failed to toggle student menu', intent: 'toggleStudentMenu' };
    }
  }

  if (intent === 'togglePublic') {
    await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'toggle_public',
    });

    try {
      const data = await request.json();
      await ClassmojiService.page.quickUpdate(pageId, {
        is_public: data.is_public,
      });
      return { success: true, intent: 'togglePublic' };
    } catch (error) {
      console.error('Failed to toggle public:', error);
      return { error: error.message || 'Failed to toggle public', intent: 'togglePublic' };
    }
  }

  // Header image handlers
  if (intent === 'upload-header-image') {
    if (!formData) formData = await request.formData();
    try {
      const file = formData.get('file');

      if (!file || typeof file === 'string') {
        return Response.json(
          { error: 'No file provided', intent: 'upload-header-image' },
          { status: 400 }
        );
      }

      await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'PAGES',
        attemptedAction: 'upload_header_image',
      });

      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: true,
      });

      if (!page) {
        return Response.json(
          { error: 'Page not found', intent: 'upload-header-image' },
          { status: 404 }
        );
      }

      const gitOrg = page.classroom.git_organization;
      const term = generateTermString(page.classroom.term, page.classroom.year);
      const repo = `content-${gitOrg.login}-${term}`;

      // Upload header image to content repo (in page folder, not assets)
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const result = await ContentService.upload({
        gitOrganization: gitOrg,
        repo,
        file: buffer,
        filename: `header.${ext}`,
        folder: page.content_path,
        message: `Upload header image for ${page.title}`,
      });

      // Update page with new header image URL
      await ClassmojiService.page.quickUpdate(pageId, {
        header_image_url: result.url,
        updated_at: new Date(),
      });

      return Response.json({
        success: true,
        url: result.url,
        intent: 'upload-header-image',
      });
    } catch (error) {
      console.error('[upload-header-image action] Upload failed:', error);
      return Response.json(
        { error: error.message || 'Failed to upload header image', intent: 'upload-header-image' },
        { status: 500 }
      );
    }
  }

  if (intent === 'set-header-image') {
    try {
      await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'PAGES',
        attemptedAction: 'set_header_image',
      });

      const data = await request.json();
      const { url, position } = data;

      const updateData = {
        header_image_url: url || null,
        updated_at: new Date(),
      };

      if (typeof position === 'number') {
        updateData.header_image_position = position;
      }

      await ClassmojiService.page.quickUpdate(pageId, updateData);

      return Response.json({ success: true, intent: 'set-header-image' });
    } catch (error) {
      console.error('[set-header-image action] Failed:', error);
      return Response.json(
        { error: error.message || 'Failed to set header image', intent: 'set-header-image' },
        { status: 500 }
      );
    }
  }

  if (intent === 'import-content') {
    if (!formData) formData = await request.formData();
    console.log('[import-content] Starting import...');
    try {
      const markdownFile = formData.get('markdown');
      const imageFiles = formData.getAll('images');

      console.log('[import-content] Markdown file:', markdownFile?.name);
      console.log('[import-content] Image files:', imageFiles.length);

      if (!markdownFile || typeof markdownFile === 'string') {
        console.error('[import-content] No markdown file provided');
        return Response.json(
          { error: 'No markdown file provided', intent: 'import-content' },
          { status: 400 }
        );
      }

      await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'PAGES',
        attemptedAction: 'import_markdown',
      });

      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: true,
      });

      if (!page) {
        return Response.json(
          { error: 'Page not found', intent: 'import-content' },
          { status: 404 }
        );
      }

      const gitOrg = page.classroom.git_organization;
      const term = generateTermString(page.classroom.term, page.classroom.year);
      const repo = `content-${gitOrg.login}-${term}`;
      const assetsFolder = `${page.content_path}/assets`;

      // Read markdown content
      const markdownText = await markdownFile.text();
      console.log('[import-content] Markdown length:', markdownText.length);

      if (!markdownText.trim()) {
        console.error('[import-content] Markdown file is empty');
        return Response.json(
          { error: 'Markdown file is empty', intent: 'import-content' },
          { status: 400 }
        );
      }

      // Extract title from markdown (first H1)
      const extractedTitle = extractTitleFromMarkdown(markdownText);
      console.log('[import-content] Extracted title:', extractedTitle);

      // Process markdown and images
      console.log('[import-content] Processing markdown...');
      const { html, imageMap, unmatchedImages, missingImages } = await processMarkdownImport(
        markdownText,
        imageFiles,
        {
          org: gitOrg.login,
          repo,
          contentPath: page.content_path,
          assetsFolder,
        }
      );

      // Upload images to GitHub (if any)
      const filesToUpload = [];

      // Add all matched images
      imageMap.forEach(imageInfo => {
        filesToUpload.push({
          path: imageInfo.newPath,
          content: imageInfo.file,
          encoding: 'binary',
        });
      });

      // Add unmatched images (they may be referenced but not detected)
      unmatchedImages.forEach(file => {
        const timestamp = Date.now();
        const sanitizedName = file.name
          .toLowerCase()
          .replace(/[^a-z0-9.-]/g, '-')
          .replace(/-+/g, '-');
        const newFilename = `${sanitizedName.split('.')[0]}-${timestamp}.${sanitizedName.split('.').pop()}`;
        const newPath = `${page.content_path}/assets/${newFilename}`;

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

      // Add HTML content
      const wrappedHtml = wrapHtmlContent(html, page.width);
      const htmlPath = `${page.content_path}/index.html`;
      uploadFiles.push({
        path: htmlPath,
        content: wrappedHtml,
        encoding: 'utf-8',
      });

      // Upload all files in a single batch
      console.log('[import-content] Uploading', uploadFiles.length, 'files to GitHub...');
      if (uploadFiles.length > 0) {
        await ContentService.uploadBatch({
          gitOrganization: gitOrg,
          repo,
          files: uploadFiles,
          branch: 'main',
          message: `Import content for ${page.title}`,
        });
      }
      console.log('[import-content] Upload complete');

      // Update page timestamp
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });

      // Return the body content (without wrapper) for the editor
      const bodyContent = extractBodyContent(wrappedHtml);

      console.log('[import-content] Success! Returning content...');
      return Response.json({
        success: true,
        content: bodyContent,
        title: extractedTitle,
        imageCount: imageMap.size + unmatchedImages.length,
        missingImageCount: missingImages.length,
        intent: 'import-content',
      });
    } catch (error) {
      console.error('[import-content action] Failed:', error);
      return Response.json(
        {
          error: error.message || 'Failed to import content',
          intent: 'import-content',
        },
        { status: 500 }
      );
    }
  }

  if (intent === 'save') {
    if (!formData) formData = await request.formData();
    const markdownContent = formData.get('content');
    const newTitle = formData.get('title');

    await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'edit_page',
    });

    const page = await ClassmojiService.page.findById(pageId, {
      includeClassroom: true,
    });

    if (!page) {
      return { error: 'Page not found' };
    }

    const gitOrg = page.classroom.git_organization;
    const term = generateTermString(page.classroom.term, page.classroom.year);
    const repo = `content-${gitOrg.login}-${term}`;
    const filePath = `${page.content_path}/index.html`;

    // Wrap HTML content in full document with the page's width setting
    const htmlContent = wrapHtmlContent(markdownContent, page.width);

    // Determine the title to save (null if empty/untitled)
    const titleToSave = newTitle?.trim() || null;

    try {
      // Save to GitHub
      await ContentService.put({
        gitOrganization: gitOrg,
        repo,
        path: filePath,
        content: htmlContent,
        message: `Update page: ${titleToSave || page.title}`,
      });

      // Update page's title and updated_at timestamp
      await ClassmojiService.page.quickUpdate(pageId, {
        title: titleToSave,
        updated_at: new Date(),
      });

      return { success: true };
    } catch (error) {
      console.error('Failed to save page:', error);
      return { error: error.message || 'Failed to save page' };
    }
  }

  return { error: 'Invalid action' };
};
