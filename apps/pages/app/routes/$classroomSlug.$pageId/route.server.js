import { ClassmojiService, getAuthSession } from '~/utils/db.server.js';
import { loadPageContent, savePageContent, savePageCoverImage, uploadPageAsset } from '~/utils/content.server.js';
import { migrateHtmlToBlockNote } from '~/utils/migration.server.js';
import { schema } from '~/components/editor/blocks/index.jsx';

/**
 * Public page viewer route - read-only view for students and public access.
 *
 * GET /:classroomSlug/:pageId — Public/Student viewer (no edit mode)
 */
export const loader = async ({ params, request }) => {
  const { classroomSlug, pageId } = params;

  // Fetch page with classroom
  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: true,
  });

  if (!page) {
    throw new Response('Page not found', { status: 404 });
  }

  // Verify classroom slug matches
  if (page.classroom.slug !== classroomSlug) {
    throw new Response('Page not found', { status: 404 });
  }

  // Check user auth and membership
  const authData = await getAuthSession(request).catch(() => null);
  let userRole = null;
  let canEdit = false;

  if (authData?.userId) {
    const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      page.classroom.id,
      authData.userId
    );
    if (membership) {
      userRole = membership.role;
      canEdit = ['OWNER', 'TEACHER'].includes(userRole);
    }
  }

  // Block access to draft pages (teaching team can view drafts)
  const canViewDrafts = ['OWNER', 'TEACHER', 'ASSISTANT'].includes(userRole);
  if (page.is_draft && !canViewDrafts) {
    throw new Response('This page is not yet published', { status: 403 });
  }

  // For non-public pages, check if user is enrolled in the classroom
  if (!page.is_public && !userRole) {
    throw new Response('Page is not public', { status: 403 });
  }

  // Load content from GitHub
  const { format, content, coverImage: jsonCoverImage } = await loadPageContent(page);

  let viewerContent;

  if (format === 'json') {
    viewerContent = content;
  } else if (format === 'html') {
    // Migrate HTML to BlockNote JSON for viewing
    viewerContent = await migrateHtmlToBlockNote(content, schema);
  } else {
    // Empty page
    viewerContent = [{ type: 'paragraph', content: [] }];
  }

  // Cover image: prefer JSON metadata, fall back to DB columns (legacy pages)
  const coverImage = jsonCoverImage || (page.header_image_url
    ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
    : null);

  // Build GitHub repo info for link
  const gitOrg = page.classroom.git_organization;
  const term = page.classroom.term;
  const year = page.classroom.year;

  // Generate term string (format: 25w for Winter 2025)
  const generateTermString = (term, year) => {
    if (!term || !year) return null;
    const termMap = { Winter: 'w', Spring: 's', Summer: 'u', Fall: 'f' };
    const yearShort = String(year).slice(-2);
    return `${yearShort}${termMap[term] || term.charAt(0).toLowerCase()}`;
  };

  const termString = generateTermString(term, year);
  const repoName = termString ? `content-${gitOrg?.login}-${termString}` : null;

  return {
    page: {
      id: page.id,
      title: page.title,
      slug: page.slug,
      width: page.width,
      is_draft: page.is_draft,
      is_public: page.is_public,
      content_path: page.content_path,
    },
    classroom: {
      id: page.classroom.id,
      name: page.classroom.name,
      slug: page.classroom.slug,
      avatar_url: page.classroom.avatar_url,
      git_organization: gitOrg ? {
        login: gitOrg.login,
        repo: repoName,
        avatar_url: gitOrg.avatar_url,
      } : null,
    },
    content: viewerContent,
    coverImage,
    userRole,
    canEdit,
  };
};

/**
 * Actions for page mutations (edit mode only).
 */
export const action = async ({ params, request }) => {
  const { pageId } = params;

  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: true,
  });

  if (!page) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }

  // Check if user can edit
  const authData = await getAuthSession(request).catch(() => null);
  if (!authData?.userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    page.classroom.id,
    authData.userId
  );

  const canEdit = membership && ['OWNER', 'TEACHER'].includes(membership.role);
  if (!canEdit) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Support both JSON and multipart form data (for file uploads)
  const contentType = request.headers.get('content-type') || '';
  let data, formData;
  if (contentType.includes('multipart/form-data')) {
    formData = await request.formData();
    data = { intent: formData.get('intent') };
  } else {
    data = await request.json();
  }
  const { intent } = data;

  if (intent === 'save') {
    try {
      const blocks = JSON.parse(data.content);
      await savePageContent(page, blocks);
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true });
    } catch (error) {
      console.error('Failed to save page:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  if (intent === 'update-title') {
    try {
      await ClassmojiService.page.quickUpdate(pageId, {
        title: data.title,
        updated_at: new Date(),
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  if (intent === 'update-width') {
    try {
      await ClassmojiService.page.quickUpdate(pageId, {
        width: data.width,
        updated_at: new Date(),
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  if (intent === 'set-header-image') {
    try {
      const coverImage = data.url
        ? { url: data.url, position: typeof data.position === 'number' ? data.position : 50 }
        : null;
      await savePageCoverImage(page, coverImage);
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  if (intent === 'upload-header-image') {
    try {
      const file = formData?.get('file');
      if (!file || typeof file === 'string') {
        return Response.json({ error: 'No file provided' }, { status: 400 });
      }
      const { url } = await uploadPageAsset(page, file);
      await savePageCoverImage(page, { url, position: 50 });
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true, url });
    } catch (error) {
      console.error('Failed to upload header image:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
};
