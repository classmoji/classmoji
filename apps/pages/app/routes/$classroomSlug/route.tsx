import { useLoaderData, redirect, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import useLocalStorageState from 'use-local-storage-state';

import {
  PAGE_ESC_MESSAGE,
  buildNavMessage,
  resolveEmbedParentOrigin,
  resolveNavGridHref,
} from './embedBridge.ts';

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
    // The single origin this document may talk to when embedded (null = stay
    // silent). Resolved from server config, with the URL's parentOrigin claim
    // used only as a cross-check — see embedBridge.ts.
    embedParentOrigin: resolveEmbedParentOrigin({
      isEmbedded,
      parentOriginParam: url.searchParams.get('parentOrigin'),
      webappUrl: process.env.WEBAPP_URL,
    }),
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
  const { isEmbedded, embedParentOrigin, classroom, pages, membership } =
    useLoaderData<typeof loader>();
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useLocalStorageState('classmoji-pages-sidebar-collapsed', {
    defaultValue: false,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  // Being inside a frame is the durable fact of an embedded session; `isEmbedded`
  // is only per-request (`?embed=true`) and a bare in-frame link drops it. Treat
  // any framed document as embedded so a param-less landing never commits the
  // full PagesLayout chrome into the drawer. Lazy initializer (not inline) so the
  // server render — where `window` is undefined — resolves to false consistently.
  const [framed] = useState(() => typeof window !== 'undefined' && window.self !== window.top);

  // The parent origin, held sticky across a bare pass. A bare (no-`embed`)
  // navigation makes the loader resolve `embedParentOrigin` to null; without a
  // sticky copy the nav/Esc bridges would fall silent mid-session. Written on
  // every render that carries a real origin, read from `.current` at post time.
  const parentOriginRef = useRef(embedParentOrigin);
  if (embedParentOrigin) parentOriginRef.current = embedParentOrigin;

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

  /* ---- Embed bridge (see ./embedBridge.ts) ------------------------------ */

  // Keep the URL honest for reload/share after a bare in-frame landing.
  //
  // The render guard below already keeps a framed document chrome-less whatever
  // the URL says, so this no longer needs to force a loader pass — it just
  // rewrites the address bar to carry `embed=true` (a `replaceState`, not a
  // `navigate`, so there is no second loader run and no doubled GitHub read).
  // `theme`/`parentOrigin` ride along untouched via `new URL(href)`. Guarded on
  // already-embedded, so it runs at most once per navigation and cannot loop.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('embed') === 'true') return;
    url.searchParams.set('embed', 'true');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, [location.key]);

  // Tell the host which page is on screen — on mount and after every in-frame
  // navigation — so its header title and ↗ target track the reader. Reads the
  // sticky origin from the ref so a bare pass (loader origin momentarily null)
  // cannot silence the bridge mid-session.
  useEffect(() => {
    const parentOrigin = parentOriginRef.current;
    if (!parentOrigin || typeof window === 'undefined') return;
    if (window.parent === window) return;
    const page = pages.find(p => p.id === currentPageId);
    if (!page) return;
    window.parent.postMessage(
      buildNavMessage({ classroomSlug: classroom.slug, page }),
      parentOrigin
    );
  }, [currentPageId, pages, classroom.slug]);

  // Escape belongs to the host's drawer, but focus is in this document, so the
  // keydown never reaches it. Forward the intent rather than acting on it —
  // UNLESS something in this document already handled the Escape. In the peek
  // drawer a staff user's page is still editable, and BlockNote calls
  // preventDefault on every Escape it consumes (closing a menu, blurring). Left
  // unchecked, that Escape would close the whole drawer and discard typed edits.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.parent === window) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      const parentOrigin = parentOriginRef.current;
      if (!parentOrigin) return;
      window.parent.postMessage({ type: PAGE_ESC_MESSAGE }, parentOrigin);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  // Resolve the authored page-directory hub. NavGridStatic deliberately emits
  // `href="#"` + data-page-id and leaves the real URL to its consumer; without
  // this the hub is dead inside the reader, and the hub IS the navigation.
  // Gated on `isEmbedded || framed` to match the render guard — a framed-but-
  // bare pass still renders the chrome-less hub, so its links must resolve too.
  // Passing the live search shares embed/parentOrigin/theme forwarding with the
  // pageLink block (see buildEmbeddedPageHref).
  useEffect(() => {
    if ((!isEmbedded && !framed) || typeof document === 'undefined') return;
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[data-page-id]');
      const href = resolveNavGridHref(
        anchor as Element | null,
        classroom.slug,
        window.location.search
      );
      if (!href) return;
      event.preventDefault();
      navigate(href);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [isEmbedded, framed, classroom.slug, navigate]);

  // If embedded (or merely framed — a bare in-frame landing), render without
  // sidebar so the editor chrome never pops into the host's drawer.
  if (isEmbedded || framed) {
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
