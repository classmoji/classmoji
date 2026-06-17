import { useEffect, useMemo, useState } from 'react';
import { data, useFetcher, useNavigate, useParams } from 'react-router';
import { Button, Tag, Popconfirm, Modal, Select, Segmented, Switch, Tooltip } from 'antd';
import {
  IconChevronLeft,
  IconStack2,
  IconPencil,
  IconTrash,
  IconFileText,
  IconFolder,
  IconPresentation,
  IconHelpCircle,
  IconArrowUp,
  IconArrowDown,
  IconPlus,
  type Icon,
} from '@tabler/icons-react';

import { ClassmojiService } from '@classmoji/services';
import type { ModuleItemType } from '@prisma/client';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import ModuleFormModal, { type ModuleFormModule } from '../admin.$class.modules/ModuleFormModal';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, module: moduleSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  // The module and the picker's candidate content are independent — fetch in parallel.
  const [module, candidates] = await Promise.all([
    ClassmojiService.module.findByClassroomSlugAndModuleSlug(classSlug!, moduleSlug!),
    ClassmojiService.module.getCandidateContent(classroom.id),
  ]);

  if (!module) {
    throw data('Module not found', { status: 404 });
  }

  return { module, candidates };
};

type ModuleItem = Route.ComponentProps['loaderData']['module']['items'][number];

const TYPE_META: Record<ModuleItemType, { label: string; icon: Icon }> = {
  PAGE: { label: 'Page', icon: IconFileText },
  REPOSITORY: { label: 'Repository', icon: IconFolder },
  QUIZ: { label: 'Quiz', icon: IconHelpCircle },
  SLIDE: { label: 'Slides', icon: IconPresentation },
};

const itemLabel = (item: ModuleItem): string => {
  switch (item.item_type) {
    case 'PAGE':
      return item.page?.title ?? '(deleted page)';
    case 'REPOSITORY':
      return item.repository?.title ?? '(deleted repository)';
    case 'QUIZ':
      return item.quiz?.name ?? '(deleted quiz)';
    case 'SLIDE':
      return item.slide?.title ?? '(deleted slides)';
    default:
      return 'Unknown';
  }
};

// Display label + student-visibility for an item. Publish state delegates to the
// service's isItemPublished so the admin "Published/Draft" pill can never drift
// from what students actually see.
const describeItem = (item: ModuleItem): { label: string; published: boolean } => ({
  label: itemLabel(item),
  published: ClassmojiService.module.isItemPublished(item),
});

const ModuleDetail = ({ loaderData }: Route.ComponentProps) => {
  const { module, candidates } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();

  // Navigates away after delete; item ops revalidate in place.
  const deleteFetcher = useFetcher<{ success?: string; error?: string }>();
  const itemFetcher = useFetcher<{ success?: string; error?: string }>();

  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<ModuleItemType>('PAGE');
  const [addTargetId, setAddTargetId] = useState<string | undefined>();

  const items = module.items;
  const busy = itemFetcher.state !== 'idle';

  // Return to the list once the module is deleted.
  useEffect(() => {
    if (deleteFetcher.state === 'idle' && deleteFetcher.data?.success) {
      navigate(`/admin/${classSlug}/modules`);
    }
  }, [deleteFetcher.state, deleteFetcher.data, classSlug, navigate]);

  // Close + reset the add modal once an add settles successfully.
  useEffect(() => {
    if (itemFetcher.state === 'idle' && itemFetcher.data?.success && addOpen) {
      setAddOpen(false);
      setAddTargetId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemFetcher.state, itemFetcher.data]);

  const post = (action: string, payload: Record<string, unknown>) =>
    itemFetcher.submit(JSON.stringify(payload), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/${action}`,
      encType: 'application/json',
    });

  const addItem = () => {
    if (!addTargetId) return;
    post('addItem', { moduleId: module.id, itemType: addType, targetId: addTargetId });
  };

  const removeItem = (moduleItemId: string) => post('removeItem', { moduleItemId });

  const setPublished = (checked: boolean) =>
    post('setPublished', { id: module.id, isPublished: checked });

  // Move an item up/down by one and persist the full new order.
  const move = (index: number, dir: -1 | 1) => {
    const next = index + dir;
    if (next < 0 || next >= items.length) return;
    const ordered = items.map(i => i.id);
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    post('reorderItems', { moduleId: module.id, orderedItemIds: ordered });
  };

  const deleteModule = () =>
    deleteFetcher.submit(JSON.stringify({ id: module.id }), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/delete`,
      encType: 'application/json',
    });

  // Target ids already in this module, so the picker can exclude them.
  const addedIds = useMemo(
    () => ({
      PAGE: new Set(items.filter(i => i.item_type === 'PAGE').map(i => i.page_id)),
      REPOSITORY: new Set(
        items.filter(i => i.item_type === 'REPOSITORY').map(i => i.repository_id)
      ),
      QUIZ: new Set(items.filter(i => i.item_type === 'QUIZ').map(i => i.quiz_id)),
      SLIDE: new Set(items.filter(i => i.item_type === 'SLIDE').map(i => i.slide_id)),
    }),
    [items]
  );

  const candidateOptions = (type: ModuleItemType) => {
    switch (type) {
      case 'PAGE':
        return candidates.pages
          .filter(p => !addedIds.PAGE.has(p.id))
          .map(p => ({ value: p.id, label: p.title }));
      case 'REPOSITORY':
        return candidates.repositories
          .filter(r => !addedIds.REPOSITORY.has(r.id))
          .map(r => ({ value: r.id, label: r.title }));
      case 'QUIZ':
        return candidates.quizzes
          .filter(q => !addedIds.QUIZ.has(q.id))
          .map(q => ({ value: q.id, label: q.name }));
      case 'SLIDE':
        return candidates.slides
          .filter(s => !addedIds.SLIDE.has(s.id))
          .map(s => ({ value: s.id, label: s.title }));
      default:
        return [];
    }
  };

  const editModule: ModuleFormModule = {
    id: module.id,
    title: module.title,
    description: module.description,
  };

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

        <div className="flex items-center gap-4">
          <Tooltip title="When on, students see this module (published items only).">
            <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
              <Switch
                size="small"
                checked={module.is_published}
                onChange={setPublished}
                loading={busy}
              />
              Visible to students
            </label>
          </Tooltip>
          <Button icon={<IconPencil size={16} />} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Popconfirm
            title="Delete module"
            description="This removes the module. Its items (pages, repositories, quizzes, slides) are kept."
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

      {/* Ordered content list */}
      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-2">Content</h2>
          <Button size="small" icon={<IconPlus size={15} />} onClick={() => setAddOpen(true)}>
            Add item
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-10 text-gray-500">
            <div className="font-medium">No items in this module</div>
            <div className="text-sm">
              Use “Add item” to place pages, repositories, quizzes or slides in order.
            </div>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {items.map((item, index) => {
              const meta = TYPE_META[item.item_type];
              const ItemIcon = meta.icon;
              const { label, published } = describeItem(item);
              return (
                <li key={item.id} className="flex items-center gap-3 py-2.5">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={index === 0 || busy}
                      onClick={() => move(index, -1)}
                      className="text-gray-400 hover:text-ink-1 disabled:opacity-30 disabled:hover:text-gray-400"
                    >
                      <IconArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={index === items.length - 1 || busy}
                      onClick={() => move(index, 1)}
                      className="text-gray-400 hover:text-ink-1 disabled:opacity-30 disabled:hover:text-gray-400"
                    >
                      <IconArrowDown size={15} />
                    </button>
                  </div>

                  <ItemIcon size={18} className="text-gray-400 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-ink-1">{label}</span>

                  <Tag className="shrink-0">{meta.label}</Tag>
                  <Tag color={published ? 'green' : 'orange'} className="shrink-0">
                    {published ? 'Published' : 'Draft'}
                  </Tag>

                  <Popconfirm
                    title="Remove from module"
                    description="This removes the item from this module. The item itself is kept."
                    okText="Remove"
                    cancelText="Cancel"
                    onConfirm={() => removeItem(item.id)}
                  >
                    <Button type="text" size="small" danger icon={<IconTrash size={15} />} />
                  </Popconfirm>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ModuleFormModal open={editOpen} module={editModule} onClose={() => setEditOpen(false)} />

      <Modal
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        title="Add item to module"
        okText="Add"
        onOk={addItem}
        okButtonProps={{ disabled: !addTargetId }}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
      >
        <div className="flex flex-col gap-3 mt-2">
          <Segmented
            block
            value={addType}
            onChange={value => {
              setAddType(value as ModuleItemType);
              setAddTargetId(undefined);
            }}
            options={(Object.keys(TYPE_META) as ModuleItemType[]).map(t => ({
              value: t,
              label: TYPE_META[t].label,
            }))}
          />
          <Select
            showSearch
            allowClear
            className="w-full"
            placeholder={`Select a ${TYPE_META[addType].label.toLowerCase()}…`}
            optionFilterProp="label"
            value={addTargetId}
            onChange={setAddTargetId}
            options={candidateOptions(addType)}
            notFoundContent="Nothing available to add"
          />
        </div>
      </Modal>
    </div>
  );
};

export default ModuleDetail;
