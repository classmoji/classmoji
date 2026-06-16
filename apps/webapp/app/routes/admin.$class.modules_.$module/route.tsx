import { useEffect, useState } from 'react';
import { data, useFetcher, useNavigate, useParams } from 'react-router';
import { Button, Table, Tag, Popconfirm, Modal, Select } from 'antd';
import {
  IconChevronLeft,
  IconStack2,
  IconPencil,
  IconTrash,
  IconFileText,
  IconPlus,
} from '@tabler/icons-react';

import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import ModuleFormModal, { type ModuleFormModule } from '../admin.$class.modules/ModuleFormModal';
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

  // All repositories in the classroom, for the "manage repositories" picker.
  const allRepos = await ClassmojiService.repository.findByClassroomSlug(classSlug!);
  const repositories = allRepos.map(r => ({
    id: r.id,
    title: r.title,
    module_id: (r as { module_id?: string | null }).module_id ?? null,
  }));

  return { module, pages, repositories };
};

const ModuleDetail = ({ loaderData }: Route.ComponentProps) => {
  const { module, pages, repositories } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ success?: string; error?: string }>();
  // Separate fetcher for repo changes so it revalidates in place instead of
  // navigating away like the delete fetcher does.
  const repoFetcher = useFetcher<{ success?: string; error?: string }>();
  const [editOpen, setEditOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);

  // After a successful delete, return to the modules list.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      navigate(`/admin/${classSlug}/modules`);
    }
  }, [fetcher.state, fetcher.data, classSlug, navigate]);

  // Close the manage modal once a repo change settles.
  useEffect(() => {
    if (repoFetcher.state === 'idle' && repoFetcher.data?.success) {
      setManageOpen(false);
    }
  }, [repoFetcher.state, repoFetcher.data]);

  const saving = repoFetcher.state !== 'idle';

  const submitRepositories = (repositoryIds: string[]) => {
    repoFetcher.submit(JSON.stringify({ moduleId: module.id, repositoryIds }), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/setRepositories`,
      encType: 'application/json',
    });
  };

  const openManage = () => {
    setSelectedRepoIds(module.repositories.map(r => r.id));
    setManageOpen(true);
  };

  const removeRepository = (repoId: string) => {
    submitRepositories(module.repositories.map(r => r.id).filter(id => id !== repoId));
  };

  const deleteModule = () => {
    fetcher.submit(JSON.stringify({ id: module.id }), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/delete`,
      encType: 'application/json',
    });
  };

  // Label other-module members so it's clear selecting them will move them here.
  const otherModuleIds = new Set(
    repositories.filter(r => r.module_id && r.module_id !== module.id).map(r => r.id)
  );

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
      width: 160,
      render: (_: unknown, repo: (typeof module.repositories)[number]) => (
        <div className="flex items-center gap-3 justify-end whitespace-nowrap">
          <Button
            type="link"
            size="small"
            className="px-0"
            onClick={() => navigate(`/admin/${classSlug}/repos/${encodeURIComponent(repo.title)}`)}
          >
            Open
          </Button>
          <Popconfirm
            title="Remove from module"
            description="This removes the repository from this module. The repository itself is kept."
            okText="Remove"
            cancelText="Cancel"
            onConfirm={() => removeRepository(repo.id)}
          >
            <Button type="link" size="small" danger className="px-0">
              Remove
            </Button>
          </Popconfirm>
        </div>
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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-2">Repositories</h2>
          <Button size="small" icon={<IconPlus size={15} />} onClick={openManage}>
            Add repositories
          </Button>
        </div>
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
                  Use “Add repositories” to put repositories in this module.
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

      <Modal
        open={manageOpen}
        onCancel={() => setManageOpen(false)}
        title="Add repositories to module"
        okText="Save"
        onOk={() => submitRepositories(selectedRepoIds)}
        confirmLoading={saving}
        cancelButtonProps={{ disabled: saving }}
      >
        <p className="text-sm text-ink-3 mb-3">
          Select the repositories that belong to this module. Unchecking one removes it from the
          module (the repository itself is kept).
        </p>
        <Select
          mode="multiple"
          allowClear
          className="w-full"
          placeholder="Select repositories…"
          optionFilterProp="label"
          value={selectedRepoIds}
          onChange={setSelectedRepoIds}
          options={repositories.map(r => ({
            value: r.id,
            label: otherModuleIds.has(r.id) ? `${r.title} (in another module)` : r.title,
          }))}
        />
      </Modal>
    </div>
  );
};

export default ModuleDetail;
