import { useEffect, useState } from 'react';
import { data, useFetcher, useNavigate, useParams } from 'react-router';
import { Button, Table, Tag, Popconfirm } from 'antd';
import { IconChevronLeft, IconStack2, IconPencil, IconTrash, IconFileText } from '@tabler/icons-react';

import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import ModuleFormModal, {
  type ModuleFormModule,
} from '../admin.$class.modules/ModuleFormModal';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, module: moduleSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  const module = await ClassmojiService.module.findByClassroomSlugAndModuleSlug(
    classSlug!,
    moduleSlug!
  );

  if (!module) {
    throw data('Module not found', { status: 404 });
  }

  const pages = await ClassmojiService.page.findByClassroomId(classroom.id);

  return { module, pages };
};

const ModuleDetail = ({ loaderData }: Route.ComponentProps) => {
  const { module, pages } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ success?: string; error?: string }>();
  const [editOpen, setEditOpen] = useState(false);

  // After a successful delete, return to the modules list.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      navigate(`/admin/${classSlug}/modules`);
    }
  }, [fetcher.state, fetcher.data, classSlug, navigate]);

  const deleteModule = () => {
    fetcher.submit(JSON.stringify({ id: module.id }), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/delete`,
      encType: 'application/json',
    });
  };

  const editModule: ModuleFormModule = {
    id: module.id,
    title: module.title,
    description: module.description,
    pages: module.pages.map(pl => ({ page_id: pl.page_id })),
  };

  const repoColumns = [
    {
      title: 'Repository',
      key: 'title',
      render: (_: unknown, repo: (typeof module.repositories)[number]) => (
        <span className="font-medium text-ink-1">{repo.title}</span>
      ),
    },
    {
      title: 'Type',
      key: 'type',
      width: 140,
      render: (_: unknown, repo: (typeof module.repositories)[number]) => (
        <Tag>{repo.type === 'INDIVIDUAL' ? 'Individual' : 'Group'}</Tag>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_: unknown, repo: (typeof module.repositories)[number]) => (
        <Tag color={repo.is_published ? 'green' : 'orange'}>
          {repo.is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, repo: (typeof module.repositories)[number]) => (
        <Button
          type="link"
          size="small"
          onClick={() =>
            navigate(`/admin/${classSlug}/repos/${encodeURIComponent(repo.title)}`)
          }
        >
          Open
        </Button>
      ),
    },
  ];

  return (
    <div className="min-h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-ink-2">
          <button
            type="button"
            onClick={() => navigate(`/admin/${classSlug}/modules`)}
            className="hover:text-ink-1"
            aria-label="Back to modules"
          >
            <IconChevronLeft size={18} />
          </button>
          <IconStack2 size={18} className="text-gray-400" />
          <button
            type="button"
            onClick={() => navigate(`/admin/${classSlug}/modules`)}
            className="hover:text-ink-1"
          >
            Modules
          </button>
          <span className="text-ink-3">/</span>
          <span className="font-semibold text-ink-1">{module.title}</span>
        </div>

        <div className="flex items-center gap-2">
          <Button icon={<IconPencil size={16} />} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Popconfirm
            title="Delete module"
            description="This removes the module. Its repositories are kept and become ungrouped."
            okText="Delete"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            onConfirm={deleteModule}
          >
            <Button danger icon={<IconTrash size={16} />}>
              Delete
            </Button>
          </Popconfirm>
        </div>
      </div>

      {module.description && (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 mb-4 text-sm text-ink-2 whitespace-pre-wrap">
          {module.description}
        </div>
      )}

      {/* Member repositories */}
      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 mb-4">
        <h2 className="text-sm font-semibold text-ink-2 mb-3">Repositories</h2>
        <Table
          columns={repoColumns}
          dataSource={module.repositories}
          rowKey="id"
          rowHoverable={false}
          size="middle"
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <div className="text-center py-10 text-gray-500">
                <div className="font-medium">No repositories in this module</div>
                <div className="text-sm">
                  Assign repositories to this module from the repository form.
                </div>
              </div>
            ),
          }}
        />
      </div>

      {/* Linked pages */}
      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-ink-2 mb-3">Pages</h2>
        {module.pages.length === 0 ? (
          <div className="text-sm text-ink-3">No pages linked to this module.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {module.pages.map(pl => (
              <button
                key={pl.id}
                type="button"
                onClick={() => navigate(`/admin/${classSlug}/pages/${pl.page.id}`)}
                className="flex items-center gap-2 text-sm text-ink-1 hover:text-ink-0 text-left"
              >
                <IconFileText size={16} className="text-gray-400 shrink-0" />
                <span className="truncate">{pl.page.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <ModuleFormModal
        open={editOpen}
        module={editModule}
        pages={pages}
        onClose={() => setEditOpen(false)}
      />
    </div>
  );
};

export default ModuleDetail;
