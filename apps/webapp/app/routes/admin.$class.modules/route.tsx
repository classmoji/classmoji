import { useNavigate, useParams } from 'react-router';
import { useState } from 'react';
import { Table, Tag } from 'antd';
import { namedAction } from 'remix-utils/named-action';

import { SearchInput, ButtonNew, RequireRole, TableActionButtons } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import type { ModuleItemType } from '@prisma/client';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { assertClassroomMutationAllowed } from '~/utils/helpers';
import ModuleFormModal, { type ModuleFormModule } from './ModuleFormModal';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  const modules = await ClassmojiService.module.findByClassroomSlug(classSlug!);

  return { modules };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'manage_modules',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = (await request.json()) as {
    id?: string;
    title?: string;
    description?: string | null;
    isPublished?: boolean;
    moduleId?: string;
    moduleItemId?: string;
    itemType?: ModuleItemType;
    targetId?: string;
    orderedItemIds?: string[];
  };

  return namedAction(request, {
    async create() {
      try {
        await ClassmojiService.module.create(classroom.id, {
          title: data.title!,
          description: data.description ?? null,
        });
        return { success: 'Module created' };
      } catch (error: unknown) {
        console.error('Module create error:', error);
        return { error: 'Failed to create module. Please try again.' };
      }
    },
    async update() {
      try {
        await ClassmojiService.module.updateForClassroom(data.id!, classroom.id, {
          title: data.title!,
          description: data.description ?? null,
        });
        return { success: 'Module updated' };
      } catch (error: unknown) {
        console.error('Module update error:', error);
        return { error: 'Failed to update module. Please try again.' };
      }
    },
    async delete() {
      try {
        await ClassmojiService.module.deleteById(data.id!, classroom.id);
        return { success: 'Module deleted' };
      } catch (error: unknown) {
        console.error('Module delete error:', error);
        return { error: 'Failed to delete module. Please try again.' };
      }
    },
    async setPublished() {
      try {
        await ClassmojiService.module.setPublished(
          data.id!,
          Boolean(data.isPublished),
          classroom.id
        );
        return { success: data.isPublished ? 'Module published' : 'Module unpublished' };
      } catch (error: unknown) {
        console.error('Module setPublished error:', error);
        return { error: 'Failed to update module visibility. Please try again.' };
      }
    },
    async addItem() {
      try {
        await ClassmojiService.module.addItem(
          data.moduleId!,
          data.itemType!,
          data.targetId!,
          classroom.id
        );
        return { success: 'Item added to module' };
      } catch (error: unknown) {
        console.error('Module addItem error:', error);
        return { error: 'Failed to add item. It may already be in this module.' };
      }
    },
    async removeItem() {
      try {
        await ClassmojiService.module.removeItem(data.moduleItemId!, classroom.id);
        return { success: 'Item removed from module' };
      } catch (error: unknown) {
        console.error('Module removeItem error:', error);
        return { error: 'Failed to remove item. Please try again.' };
      }
    },
    async reorderItems() {
      try {
        await ClassmojiService.module.reorderItems(
          data.moduleId!,
          data.orderedItemIds ?? [],
          classroom.id
        );
        return { success: 'Module order updated' };
      } catch (error: unknown) {
        console.error('Module reorderItems error:', error);
        return { error: 'Failed to reorder items. Please try again.' };
      }
    },
  });
};

type ModuleRow = Route.ComponentProps['loaderData']['modules'][number];

const ModulesIndex = ({ loaderData }: Route.ComponentProps) => {
  const { modules } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModuleFormModule | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (m: ModuleRow) => {
    setEditing({ id: m.id, title: m.title, description: m.description });
    setFormOpen(true);
  };

  const moduleHref = (m: ModuleRow) =>
    `/admin/${classSlug}/modules/${encodeURIComponent(m.slug ?? m.id)}`;

  const columns = [
    {
      title: 'Module',
      key: 'module',
      render: (_: unknown, m: ModuleRow) => (
        <div className="min-w-0">
          <div className="font-medium text-ink-1 truncate">{m.title}</div>
          {m.description && (
            <div className="text-xs text-ink-3 truncate max-w-md">{m.description}</div>
          )}
        </div>
      ),
    },
    {
      title: 'Items',
      key: 'items',
      width: 100,
      align: 'center' as const,
      render: (_: unknown, m: ModuleRow) => (
        <Tag color={m._count.items > 0 ? 'blue' : undefined}>{m._count.items}</Tag>
      ),
    },
    {
      title: 'Visibility',
      key: 'visibility',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, m: ModuleRow) => (
        <Tag color={m.is_published ? 'green' : 'orange'}>
          {m.is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      render: (_: unknown, m: ModuleRow) => (
        <TableActionButtons onView={() => navigate(moduleHref(m))} onEdit={() => openEdit(m)} />
      ),
    },
  ];

  const filtered = modules.filter(m => m.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="min-h-full relative">
      <div className="flex flex-col gap-3 mt-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-base font-semibold text-ink-2">Modules</h1>

        <RequireRole roles={['OWNER']}>
          <div className="flex items-center gap-3">
            <SearchInput
              query={query}
              setQuery={setQuery}
              placeholder="Search by title"
              className="flex-1 min-w-0 sm:w-56 sm:flex-none"
            />
            <ButtonNew action={openCreate}>New module</ButtonNew>
          </div>
        </RequireRole>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <Table
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          rowHoverable={false}
          size="middle"
          onRow={m => ({ onClick: () => navigate(moduleHref(m)), className: 'cursor-pointer' })}
          pagination={{
            pageSize: 25,
            showSizeChanger: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} modules`,
          }}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: query ? (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No modules found matching &apos;{query}&apos;</div>
                <div className="text-sm">Try adjusting your search terms.</div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No modules yet</div>
                <div className="text-sm">
                  Group pages, repositories, quizzes and slides into a module to organize your
                  course.
                </div>
              </div>
            ),
          }}
        />
      </div>

      <ModuleFormModal open={formOpen} module={editing} onClose={() => setFormOpen(false)} />
    </div>
  );
};

export default ModulesIndex;
