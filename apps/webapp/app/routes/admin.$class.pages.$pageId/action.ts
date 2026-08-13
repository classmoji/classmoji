import { redirect } from 'react-router';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import type { Route } from './+types/route';

interface PageWithClassroom {
  id: string;
  title: string;
  content_path: string;
  width: number;
  classroom: {
    // Stored, user-editable content repo name. Never re-derive it.
    content_repo: string;
    git_organization: {
      login: string;
      provider: string;
      github_installation_id?: string | null;
      access_token?: string | null;
      base_url?: string | null;
    };
  };
}

// Action to handle save and upload operations
export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const pageId = params.pageId!;

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
      intent = formData.get('intent') as string | null;
    }
  }

  if (intent === 'upload-image') {
    if (!formData) formData = await request.formData();
    try {
      const file = formData.get('file');

      console.error('[upload-image action] Received file:', (file as File)?.name || 'no file');
      if (!file || typeof file === 'string') {
        console.error('[upload-image action] Invalid file');
        return Response.json(
          { error: 'No file provided', intent: 'upload-image' },
          { status: 400 }
        );
      }

      // Wrap assertClassroomAccess in try-catch to ensure we always return JSON
      try {
        const { classroom, membership } = await assertClassroomAccess({
          request,
          classroomSlug: classSlug,
          allowedRoles: ['OWNER', 'TEACHER'],
          resourceType: 'PAGES',
          attemptedAction: 'upload_image',
        });
        assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
      } catch (authError) {
        console.error('[upload-image action] Authorization failed:', authError);
        return Response.json(
          {
            error: authError instanceof Error ? authError.message : 'Unauthorized to upload images',
            intent: 'upload-image',
          },
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

      const pageData = page as unknown as PageWithClassroom;
      const gitOrg = pageData.classroom.git_organization;
      const repo = pageData.classroom.content_repo;
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
    } catch (error: unknown) {
      console.error('[upload-image action] Upload failed:', error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Failed to upload image',
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
        const { classroom, membership } = await assertClassroomAccess({
          request,
          classroomSlug: classSlug,
          allowedRoles: ['OWNER', 'TEACHER'],
          resourceType: 'PAGES',
          attemptedAction: 'upload_file',
        });
        assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
      } catch (authError) {
        console.log(authError);
        return Response.json(
          {
            error: authError instanceof Error ? authError.message : 'Unauthorized to upload files',
            intent: 'upload-file',
          },
          { status: 403 }
        );
      }

      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: true,
      });

      if (!page) {
        return Response.json({ error: 'Page not found', intent: 'upload-file' }, { status: 404 });
      }

      const pageData = page as unknown as PageWithClassroom;
      const gitOrg = pageData.classroom.git_organization;
      const repo = pageData.classroom.content_repo;
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
    } catch (error: unknown) {
      console.error('[upload-file action] Upload failed:', error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Failed to upload file',
          intent: 'upload-file',
        },
        { status: 500 }
      );
    }
  }

  if (intent === 'delete') {
    const { classroom, membership } = await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'delete_page',
    });
    assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

    try {
      // Use deletePage to also delete from GitHub and update manifest
      await ClassmojiService.page.deletePage(pageId);
      // Redirect immediately to prevent loader revalidation on deleted page
      return redirect(`/admin/${classSlug}/pages?deleted=true`);
    } catch (error: unknown) {
      console.error('Failed to delete page:', error);
      return {
        error: error instanceof Error ? error.message : 'Failed to delete page',
        intent: 'delete',
      };
    }
  }

  if (intent === 'update-width') {
    if (!formData) formData = await request.formData();
    const width = parseInt(formData.get('width') as string, 10);

    const { classroom, membership } = await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'update_width',
    });
    assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

    try {
      await ClassmojiService.page.quickUpdate(pageId, {
        width,
        updated_at: new Date(),
      });

      return { success: true, intent: 'update-width' };
    } catch (error: unknown) {
      console.error('Failed to update page width:', error);
      return {
        error: error instanceof Error ? error.message : 'Failed to update page width',
        intent: 'update-width',
      };
    }
  }

  if (intent === 'toggleStudentMenu') {
    const { classroom, membership } = await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'toggle_student_menu',
    });
    assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

    try {
      const data = await request.json();
      await ClassmojiService.page.quickUpdate(pageId, {
        show_in_student_menu: data.show_in_student_menu,
      });
      return { success: true, intent: 'toggleStudentMenu' };
    } catch (error: unknown) {
      console.error('Failed to toggle student menu:', error);
      return {
        error: error instanceof Error ? error.message : 'Failed to toggle student menu',
        intent: 'toggleStudentMenu',
      };
    }
  }

  if (intent === 'togglePublic') {
    const { classroom, membership } = await assertClassroomAccess({
      request,
      classroomSlug: classSlug,
      allowedRoles: ['OWNER', 'TEACHER'],
      resourceType: 'PAGES',
      attemptedAction: 'toggle_public',
    });
    assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

    try {
      const data = await request.json();
      await ClassmojiService.page.quickUpdate(pageId, {
        is_public: data.is_public,
      });
      return { success: true, intent: 'togglePublic' };
    } catch (error: unknown) {
      console.error('Failed to toggle public:', error);
      return {
        error: error instanceof Error ? error.message : 'Failed to toggle public',
        intent: 'togglePublic',
      };
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

      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'PAGES',
        attemptedAction: 'upload_header_image',
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: true,
      });

      if (!page) {
        return Response.json(
          { error: 'Page not found', intent: 'upload-header-image' },
          { status: 404 }
        );
      }

      const pageData = page as unknown as PageWithClassroom;
      const gitOrg = pageData.classroom.git_organization;
      const repo = pageData.classroom.content_repo;

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
    } catch (error: unknown) {
      console.error('[upload-header-image action] Upload failed:', error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Failed to upload header image',
          intent: 'upload-header-image',
        },
        { status: 500 }
      );
    }
  }

  if (intent === 'set-header-image') {
    try {
      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'PAGES',
        attemptedAction: 'set_header_image',
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      const data = await request.json();
      const { url, position } = data;

      const updateData: Record<string, unknown> = {
        header_image_url: url || null,
        updated_at: new Date(),
      };

      if (typeof position === 'number') {
        updateData.header_image_position = position;
      }

      await ClassmojiService.page.quickUpdate(pageId, updateData);

      return Response.json({ success: true, intent: 'set-header-image' });
    } catch (error: unknown) {
      console.error('[set-header-image action] Failed:', error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : 'Failed to set header image',
          intent: 'set-header-image',
        },
        { status: 500 }
      );
    }
  }

  // NOTE: the legacy `save` and `import-content` intents (index.html writers)
  // were removed — page content is edited exclusively in apps/pages, which
  // writes content.json via the shared pageContent service. This route's
  // loader redirects there; only metadata/upload intents remain here.

  return { error: 'Invalid action' };
};
