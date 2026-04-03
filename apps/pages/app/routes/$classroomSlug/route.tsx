import { useLoaderData, redirect, Outlet, useParams } from 'react-router';
import { useEffect, useState } from 'react';
import useLocalStorageState from 'use-local-storage-state';

import { ClassmojiService, getAuthSession } from '~/utils/db.server.ts';

import PagesLayout from '~/components/layout/PagesLayout.tsx';
import PagesSidebar from '~/components/layout/PagesSidebar.tsx';

/**
 * Index route: displays different views based on user role.
 *
 * - Admin/Teacher → AdminDashboard (all pages, including drafts)
 * - Student/Assistant → StudentPageList (published pages)
 * - Unauthenticated → PublicLanding (public pages only) or redirect
 */
export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { classroomSlug } = params;

  // Check if embedded (hide sidebar server-side to prevent flash)
  const url = new URL(request.url);
  const isEmbedded = url.searchParams.get('embed') === 'true';

  // Fetch classroom by slug
  const classroomRaw = await ClassmojiService.classroom.findBySlug(classroomSlug!);

  if (!classroomRaw) {
    throw new Response('Classroom not found', { status: 404 });
  }
  const classroom = classroomRaw as typeof classroomRaw & {
    avatar_url?: string;
    git_organization?: typeof classroomRaw.git_organization & {
      repo?: string;
      avatar_url?: string;
    };
  };

  // Try to get auth (nullable for public access)
  let authData = null;
  try {
    authData = await getAuthSession(request);
  } catch {
    // Not authenticated
  }

  let view = 'public';
  let membership: { role: string } | null = null;
  let pages: Awaited<ReturnType<typeof ClassmojiService.page.findByClassroomId>> = [];

  if (authData) {
    // Get membership in this classroom
    membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.id,
      authData.userId
    );

    if (membership) {
      const role = membership.role;

      if (role === 'OWNER' || role === 'TEACHER') {
        view = 'admin';
        // Admin sees all pages including drafts
        pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
          includeClassroom: false,
          includeCreator: true,
        });
      } else {
        view = 'student';
        // Students/assistants see published pages only
        const allPages = await ClassmojiService.page.findByClassroomId(classroom.id, {
          includeClassroom: false,
        });
        pages = allPages.filter(p => !p.is_draft);
      }
    }
  }

  if (view === 'public') {
    // Show public non-draft pages
    const allPages = await ClassmojiService.page.findByClassroomId(classroom.id, {
      includeClassroom: false,
    });
    pages = allPages.filter(p => p.is_public && !p.is_draft);
  }

  return {
    view,
    isEmbedded,
    classroom: {
      id: classroom.id,
      name: classroom.name,
      slug: classroom.slug,
      avatar_url: classroom.avatar_url,
      git_organization: classroom.git_organization
        ? {
            login: classroom.git_organization.login,
            repo: classroom.git_organization.repo,
            avatar_url: classroom.git_organization.avatar_url,
          }
        : null,
    },
    pages: pages.map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      is_draft: p.is_draft,
      is_public: p.is_public,
      show_in_student_menu: p.show_in_student_menu,
      header_image_url: p.header_image_url,
      updated_at: p.updated_at,
      creator: p.creator ? { login: p.creator.login } : null,
    })),
    membership: membership ? { role: membership.role } : null,
  };
};

/**
 * Actions for admin dashboard.
 */
export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { classroomSlug } = params;

  // All actions require staff access
  const authData = await getAuthSession(request);
  if (!authData) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug!);

  if (!classroom) {
    return Response.json({ error: 'Classroom not found' }, { status: 404 });
  }

  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    authData.userId
  );

  if (!membership || !['OWNER', 'TEACHER'].includes(membership.role)) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- form/JSON data has dynamic shape
  let data: Record<string, any>;
  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.includes('application/json')) {
    data = await request.json();
  } else {
    const formData = await request.formData();
    data = Object.fromEntries(formData);
  }

  const { intent } = data;

  if (intent === 'create') {
    try {
      // Use provided title or fallback to timestamp-based unique title
      const baseTitle = data.title?.trim() || 'Untitled Page';
      let title = baseTitle;

      // Check if title already exists and make it unique if needed
      const existingPages = await ClassmojiService.page.findByClassroomId(classroom.id);
      const existingTitles = new Set(existingPages.map(p => p.title));

      let counter = 1;
      while (existingTitles.has(title)) {
        title = `${baseTitle} ${counter}`;
        counter++;
      }

      // Generate slug from title
      const baseSlug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'page';

      // Ensure slug is unique too
      let slug = baseSlug;
      counter = 1;
      const existingSlugs = new Set(existingPages.map(p => p.slug));
      while (existingSlugs.has(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      const page = await ClassmojiService.page.create({
        title,
        classroom_id: classroom.id,
        created_by: authData.userId,
        is_draft: true,
        content_path: `pages/${slug}`,
      });
      return redirect(`/${classroomSlug}/${page.id}`);
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  // For page-scoped actions, verify the page belongs to this classroom
  // to prevent cross-classroom mutation via crafted pageId.
  if (['delete', 'toggle-menu', 'update-status'].includes(intent)) {
    if (!data.pageId) {
      return Response.json({ error: 'Missing pageId' }, { status: 400 });
    }
    const page = await ClassmojiService.page.findById(data.pageId);
    if (!page || page.classroom_id !== classroom.id) {
      return Response.json({ error: 'Page not found' }, { status: 404 });
    }
  }

  if (intent === 'delete') {
    try {
      await ClassmojiService.page.deletePage(data.pageId);
      // Return redirect instead of JSON response
      return redirect(`/${classroomSlug}`);
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'toggle-menu') {
    try {
      await ClassmojiService.page.quickUpdate(data.pageId, {
        show_in_student_menu: data.show,
        updated_at: new Date(),
      });
      return Response.json({ success: true });
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'update-status') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic page update fields from form data
      const updates: Record<string, any> = { updated_at: new Date() };
      if ('is_draft' in data) updates.is_draft = data.is_draft;
      if ('is_public' in data) updates.is_public = data.is_public;

      await ClassmojiService.page.quickUpdate(data.pageId, updates);
      return Response.json({ success: true });
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
};

const ClassroomLayout = () => {
  const { isEmbedded, classroom, pages, membership } = useLoaderData<typeof loader>();
  const params = useParams();
  const [collapsed, setCollapsed] = useLocalStorageState('classmoji-pages-sidebar-collapsed', {
    defaultValue: false,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  const canEdit = !!(membership && ['OWNER', 'TEACHER'].includes(membership.role));
  const currentPageId = params.pageId;

  // Keyboard shortcut: Cmd/Ctrl+B to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setCollapsed(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCollapsed]);

  // If embedded, render without sidebar
  if (isEmbedded) {
    return (
      <div className="h-full w-full">
        <Outlet context={{ classroom, userRole: membership?.role, canEdit, pages, isEmbedded }} />
      </div>
    );
  }

  return (
    <PagesLayout
      collapsed={collapsed}
      onMobileMenuClick={() => setMobileOpen(true)}
      sidebar={
        <PagesSidebar
          pages={pages}
          classroom={classroom}
          currentPageId={currentPageId}
          canEdit={canEdit}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed(!collapsed)}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
      }
    >
      <Outlet context={{ classroom, userRole: membership?.role, canEdit, pages, isEmbedded }} />
    </PagesLayout>
  );
};

export default ClassroomLayout;
