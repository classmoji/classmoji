import { useState, useEffect, useRef } from 'react';
import { useFetcher, Link, Outlet, useSearchParams, useNavigate } from 'react-router';
import { Table, Tag, Button, Input, Select, Switch, Tooltip } from 'antd';
import { IconPlus, IconEyeOff, IconLock, IconWorld, IconMenu2 } from '@tabler/icons-react';
import { toast } from 'react-toastify';
import { assertClassroomAccess } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import prisma from '@classmoji/database';
import { PageHeader, TableActionButtons, RecentViewers } from '~/components';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
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

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'manage',
  });

  const formData = await request.formData();
  const intent = formData.get('intent');
  const pageId = formData.get('pageId');
  const field = formData.get('field');
  const value = formData.get('value');

  // Handle delete action
  if (intent === 'delete') {
    await ClassmojiService.page.deletePage(pageId);
    return { success: true, message: 'Page deleted successfully' };
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

    await prisma.page.update({
      where: { id: pageId },
      data: { is_draft, is_public },
    });
    return { success: true };
  }

  // Handle boolean toggles (show_in_student_menu)
  if (field === 'show_in_student_menu') {
    await prisma.page.update({
      where: { id: pageId },
      data: { show_in_student_menu: value === 'true' },
    });
    return { success: true };
  }

  return { error: 'Invalid action' };
};

// Helper to compute status from is_draft and is_public
function getPageStatus(page) {
  if (page.is_draft) return 'draft';
  if (page.is_public) return 'public';
  return 'private';
}

export default function AdminPages({ loaderData }) {
  const { classSlug, pages, pageViewers } = loaderData;
  const fetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useState('');
  const toastIdRef = useRef(null);
  const navigate = useNavigate();

  // Show toast notification after delete (from redirect)
  useEffect(() => {
    if (searchParams.get('deleted') === 'true') {
      toast.success('Page deleted successfully!');
      // Remove the query param to prevent showing toast on refresh
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Show loading toast when deleting
  useEffect(() => {
    if (fetcher.state === 'submitting') {
      toastIdRef.current = toast.loading('Deleting page...');
    } else if (fetcher.state === 'idle' && toastIdRef.current) {
      if (fetcher.data?.success) {
        toast.update(toastIdRef.current, {
          render: fetcher.data.message || 'Page deleted successfully!',
          type: 'success',
          isLoading: false,
          autoClose: 3000,
        });
      } else if (fetcher.data?.error) {
        toast.update(toastIdRef.current, {
          render: fetcher.data.error || 'Failed to delete page',
          type: 'error',
          isLoading: false,
          autoClose: 3000,
        });
      }
      toastIdRef.current = null;
    }
  }, [fetcher.state, fetcher.data]);

  // Helper to get first linked module title
  const getLinkedModuleTitle = page => {
    const moduleLink = page.links?.find(link => link.module);
    return moduleLink?.module?.title || null;
  };

  // Handle field updates (for inline editing)
  const updatePageField = (pageId, field, value) => {
    fetcher.submit(
      { pageId, field, value: String(value) },
      { method: 'post' }
    );
  };

  const filteredPages = pages
    .filter(page => {
      const moduleTitle = getLinkedModuleTitle(page);
      const matchesSearch =
        page.title.toLowerCase().includes(searchText.toLowerCase()) ||
        (moduleTitle && moduleTitle.toLowerCase().includes(searchText.toLowerCase()));

      return matchesSearch;
    })
    .sort((a, b) => {
      // Sort by module first (nulls last), then by title
      const moduleA = getLinkedModuleTitle(a) || '';
      const moduleB = getLinkedModuleTitle(b) || '';
      const moduleCompare = moduleA.localeCompare(moduleB);

      if (moduleCompare !== 0) {
        return moduleCompare;
      }

      return a.title.localeCompare(b.title);
    });

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      width: 300,
      sorter: (a, b) => a.title.localeCompare(b.title),
      render: (title, record) => (
        <Link
          to={`/admin/${classSlug}/pages/${record.id}`}
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
      render: (_, record) => {
        const viewerData = pageViewers[`pages/${record.id}`] || { viewers: [], totalCount: 0 };
        return <RecentViewers viewers={viewerData.viewers} totalCount={viewerData.totalCount} groupByRole />;
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_, record) => {
        const status = getPageStatus(record);
        return (
          <Select
            value={status}
            size="small"
            style={{ width: 110 }}
            onChange={value => updatePageField(record.id, 'status', value)}
            options={[
              { value: 'draft', label: <span className="flex items-center gap-1"><IconEyeOff size={14} /> Draft</span> },
              { value: 'private', label: <span className="flex items-center gap-1"><IconLock size={14} /> Private</span> },
              { value: 'public', label: <span className="flex items-center gap-1"><IconWorld size={14} /> Public</span> },
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
      render: (_, record) => (
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
      render: date => new Date(date).toLocaleString(),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <TableActionButtons
          onEdit={() => {
            navigate(`/admin/${classSlug}/pages/${record.id}`);
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
    <div>
      <Outlet />

      <div className="mb-4  items-center">
        <div className="flex justify-between items-start">
          <PageHeader title="Pages" routeName="pages" />
          <div className="flex gap-2 items-center justify-between">
            <Input
              placeholder="Search page..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              style={{ width: 300 }}
            />
            <Link to={`/admin/${classSlug}/pages/new`}>
              <Button type="primary" icon={<IconPlus size={16} />}>
                New Page
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="mt-4">
          <Table
            columns={columns}
            dataSource={filteredPages}
            rowKey="id"
            rowHoverable={false}
            size="middle"
            pagination={{
              defaultPageSize: filteredPages.length || 25,
              showSizeChanger: true,
              pageSizeOptions: [25, 50, 100, filteredPages.length || 100],
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} pages`,
            }}
            locale={{
              emptyText: searchText ? (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-4xl mb-2">🔍</div>
                  <div>No pages found matching &quot;{searchText}&quot;</div>
                  <div className="text-sm">Try adjusting your search terms</div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-4xl mb-2">📄</div>
                  <div>No pages created yet</div>
                  <div className="text-sm">Create your first page to get started!</div>
                </div>
              ),
            }}
          />
        </div>
      </div>
    </div>
  );
}
