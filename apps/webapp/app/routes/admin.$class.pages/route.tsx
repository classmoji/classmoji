import { useState, useEffect } from 'react';
import { useFetcher, Link, Outlet, useSearchParams, useNavigate, useLocation } from 'react-router';
import { Table, Button, Input, Select, Switch, Tooltip } from 'antd';
import { IconPlus, IconEyeOff, IconLock, IconWorld, IconMenu2, IconSearch } from '@tabler/icons-react';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import getPrisma from '@classmoji/database';
import { TableActionButtons, RecentViewers } from '~/components';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'view_pages',
  });

  // Get all pages for this classroom
  const pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
    includeCreator: true,
    includeLinks: true,
  });

  // Fetch recent viewers for all pages in one query (with total counts and roles for admin UI)
  const resourcePaths = pages.map(page => `pages/${page.id}`);
  const pageViewersMap = await ClassmojiService.resourceView.getRecentViewersForPaths({
    resourcePaths,
    classroomId: classroom.id,
    limitPerPath: 50,
    includeTotalCount: true,
    includeRoles: true,
  });

  // Convert Map to plain object for serialization (React Router can't serialize Maps)
  const pageViewers = Object.fromEntries(pageViewersMap);

  return {
    classSlug,
    classroom,
    pages,
    pageViewers,
  };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'manage',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const formData = await request.formData();
  const intent = formData.get('intent') as string | null;
  const pageId = formData.get('pageId') as string;
  const field = formData.get('field') as string | null;
  const value = formData.get('value') as string | null;

  // Every mutation below records an audit row AFTER the write lands, using the
  // classroom and role this request was authorized with. This mirrors the MCP
  // server's invariant (apps/mcp/src/tools/shared.ts: every mutation writes an
  // audit row) and uses the same resource_type vocabulary — 'PAGES' — so the
  // two surfaces can be queried together.
  const audit = (action: string, resourceId: string, metadata: Record<string, unknown>) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action,
      resourceType: 'PAGES',
      resourceId,
      metadata,
    });

  /**
   * Apply an update to a page OF THE CLASSROOM THIS REQUEST WAS AUTHORIZED FOR.
   *
   * Authorization binds to the classroom in the URL, but `pageId` arrives in the
   * form body, so the two are tied together in the query itself: the update is
   * bound to `{ id, classroom_id }` and only counts when it matched exactly one
   * row. Same pattern as the sibling slides route's `updateSlideInClassroom`.
   * It is also what makes the audit row truthful — a row naming the authorized
   * classroom must describe a write that landed in that classroom.
   */
  const updatePageInClassroom = async (data: Record<string, boolean>) => {
    const { count } = await getPrisma().page.updateMany({
      where: { id: pageId, classroom_id: classroom.id },
      data,
    });
    return count === 1;
  };

  // Handle delete action
  if (intent === 'delete') {
    // deletePage() resolves the page by id alone, so the classroom is proved
    // here before it is called.
    const page = await ClassmojiService.page.findById(pageId, { includeClassroom: false });
    if (!page || page.classroom_id !== classroom.id) {
      return { error: 'Page not found' };
    }

    await ClassmojiService.page.deletePage(pageId);
    await audit('DELETE', pageId, { tool: 'web:pages.delete', title: page.title });
    return { success: true, intent: 'delete' };
  }

  // Handle status changes (combines is_draft and is_public)
  // Using prisma directly to avoid cached service issues with new schema fields
  if (field === 'status') {
    let is_draft = false;
    let is_public = false;

    if (value === 'draft') {
      is_draft = true;
      is_public = false;
    } else if (value === 'private') {
      is_draft = false;
      is_public = false;
    } else if (value === 'public') {
      is_draft = false;
      is_public = true;
    }

    if (!(await updatePageInClassroom({ is_draft, is_public }))) {
      return { error: 'Page not found' };
    }
    await audit('UPDATE', pageId, {
      tool: 'web:pages.status',
      field: 'status',
      value,
      is_draft,
      is_public,
    });
    return { success: true };
  }

  // Handle boolean toggles (show_in_student_menu)
  if (field === 'show_in_student_menu') {
    const show_in_student_menu = value === 'true';
    if (!(await updatePageInClassroom({ show_in_student_menu }))) {
      return { error: 'Page not found' };
    }
    await audit('UPDATE', pageId, {
      tool: 'web:pages.show_in_student_menu',
      field: 'show_in_student_menu',
      value: show_in_student_menu,
    });
    return { success: true };
  }

  return { error: 'Invalid action' };
};

// Helper to compute status from is_draft and is_public
interface PageRecord {
  id: string;
  title: string;
  is_draft: boolean;
  is_public: boolean;
  show_in_student_menu: boolean;
  updated_at: string;
  links?: Array<{ repository?: { title: string } | null; [key: string]: unknown }>;
  [key: string]: unknown;
}

function getPageStatus(page: PageRecord) {
  if (page.is_draft) return 'draft';
  if (page.is_public) return 'public';
  return 'private';
}

export default function AdminPages({ loaderData }: Route.ComponentProps) {
  const { classSlug, pages, pageViewers } = loaderData;
  const fetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useState('');
  const navigate = useNavigate();
  const callout = useCallout();
  // This route is served under more than one prefix (/admin and /teacher — both
  // tiers the loader and action already allow), so links are built from the
  // prefix the user actually arrived on rather than a hardcoded '/admin'.
  const rolePrefix = useLocation().pathname.split('/')[1];

  // Show toast notification after delete (from redirect)
  useEffect(() => {
    if (searchParams.get('deleted') === 'true') {
      callout.show({ variant: 'success', title: 'Page deleted successfully!' });
      // Remove the query param to prevent showing toast on refresh
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Show success/error callout when delete completes
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.intent === 'delete' && fetcher.data.success) {
        callout.show({
          variant: 'success',
          title: 'Page deleted successfully!',
          autoDismissMs: 3000,
        });
      } else if (fetcher.data.error) {
        callout.show({
          variant: 'error',
          title: fetcher.data.error || 'Failed to delete page',
          autoDismissMs: 3000,
        });
      }
    }
  }, [fetcher.state, fetcher.data]);

  // Helper to get first linked repository title
  const getLinkedRepositoryTitle = (page: PageRecord) => {
    const moduleLink = page.links?.find(
      (link: { repository?: { title: string } | null }) => link.repository
    );
    return moduleLink?.repository?.title || null;
  };

  // Handle field updates (for inline editing)
  const updatePageField = (pageId: string, field: string, value: string | boolean) => {
    fetcher.submit({ pageId, field, value: String(value) }, { method: 'post' });
  };

  const filteredPages = pages
    .filter(page => {
      const repositoryTitle = getLinkedRepositoryTitle(page as unknown as PageRecord);
      const matchesSearch =
        page.title.toLowerCase().includes(searchText.toLowerCase()) ||
        (repositoryTitle && repositoryTitle.toLowerCase().includes(searchText.toLowerCase()));

      return matchesSearch;
    })
    .sort((a, b) => {
      // Sort by repository first (nulls last), then by title
      const repositoryA = getLinkedRepositoryTitle(a as unknown as PageRecord) || '';
      const repositoryB = getLinkedRepositoryTitle(b as unknown as PageRecord) || '';
      const repositoryCompare = repositoryA.localeCompare(repositoryB);

      if (repositoryCompare !== 0) {
        return repositoryCompare;
      }

      return a.title.localeCompare(b.title);
    });

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      width: 300,
      sorter: (a: PageRecord, b: PageRecord) => a.title.localeCompare(b.title),
      render: (title: string, record: PageRecord) => (
        <Link
          to={`/${rolePrefix}/${classSlug}/pages/${record.id}`}
          className="font-medium !text-gray-600 dark:text-gray-100 hover:text-gray-900 dark:hover:text-gray-100"
        >
          {title}
        </Link>
      ),
    },
    {
      title: 'Viewers',
      key: 'viewers',
      width: 120,
      render: (_: unknown, record: PageRecord) => {
        const rawData = pageViewers[`pages/${record.id}`] || { viewers: [], totalCount: 0 };
        const viewerData =
          'viewers' in rawData ? rawData : { viewers: rawData, totalCount: rawData.length };
        return (
          <RecentViewers
            viewers={viewerData.viewers}
            totalCount={viewerData.totalCount}
            groupByRole
          />
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_: unknown, record: PageRecord) => {
        const status = getPageStatus(record);
        return (
          <Select
            value={status}
            size="small"
            style={{ width: 110 }}
            onChange={value => updatePageField(record.id, 'status', value)}
            options={[
              {
                value: 'draft',
                label: (
                  <span className="flex items-center gap-1">
                    <IconEyeOff size={14} /> Draft
                  </span>
                ),
              },
              {
                value: 'private',
                label: (
                  <span className="flex items-center gap-1">
                    <IconLock size={14} /> Private
                  </span>
                ),
              },
              {
                value: 'public',
                label: (
                  <span className="flex items-center gap-1">
                    <IconWorld size={14} /> Public
                  </span>
                ),
              },
            ]}
          />
        );
      },
    },
    {
      title: (
        <Tooltip title="Show this page in the student navigation menu">
          <span className="flex items-center gap-1 cursor-help">
            <IconMenu2 size={14} />
            Menu
          </span>
        </Tooltip>
      ),
      key: 'show_in_student_menu',
      width: 80,
      align: 'center',
      render: (_: unknown, record: PageRecord) => (
        <Switch
          size="small"
          checked={record.show_in_student_menu}
          onChange={checked => updatePageField(record.id, 'show_in_student_menu', checked)}
        />
      ),
    },
    {
      title: 'Updated',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 180,
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, record: PageRecord) => (
        <TableActionButtons
          onEdit={() => {
            navigate(`/${rolePrefix}/${classSlug}/pages/${record.id}`);
          }}
          onDelete={() =>
            fetcher.submit({ intent: 'delete', pageId: record.id }, { method: 'post' })
          }
          deleteConfirmTitle="Delete page?"
          deleteConfirmDescription="This will delete the page record. The content in GitHub will remain."
        />
      ),
    },
  ];

  return (
    <div className="min-h-full">
      <Outlet />

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Pages</h1>
        <div className="flex items-center gap-2">
          <Input
            prefix={<IconSearch size={16} />}
            placeholder="Search page..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            style={{ width: 260 }}
          />
          <Link to={`/${rolePrefix}/${classSlug}/pages/new`} data-tour="pages-new">
            <Button type="primary" icon={<IconPlus size={16} />}>
              New Page
            </Button>
          </Link>
        </div>
      </div>

      <div

        className="rounded-2xl overflow-hidden bg-panel ring-1 ring-line min-h-[calc(100vh-10rem)] p-5 sm:p-6"
      >
        <Table
          columns={columns as Parameters<typeof Table>[0]['columns']}
          dataSource={filteredPages}
          rowKey="id"
          rowHoverable={false}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{
            defaultPageSize: filteredPages.length || 25,
            showSizeChanger: false,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} pages`,
          }}
          locale={{
            emptyText: searchText ? (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No pages found matching &quot;{searchText}&quot;</div>
                <div className="text-sm">Try adjusting your search terms</div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No pages created yet</div>
                <div className="text-sm">Create your first page to get started!</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
}
