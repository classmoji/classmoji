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
  IconForms,
  IconPresentation,
  IconHelpCircle,
  IconArrowUp,
  IconArrowDown,
  IconPlus,
  type Icon,
} from '@tabler/icons-react';

import { ClassmojiService } from '@classmoji/services';
import type { FormAccess, FormStatus, ModuleItemType } from '@prisma/client';
import { formatCloseDate } from '~/components/features/modules/ReadOnlyModulesTree';
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

/**
 * Compile-time exhaustiveness guard for the switches over ModuleItemType below,
 * mirroring the one in module.service. Adding a value to the enum without
 * teaching every switch about it becomes a type error here rather than an item
 * that silently renders as "Unknown" / unpublished / unaddable.
 */
const unhandledItemType = (type: never): never => {
  throw new Error(`Unhandled ModuleItemType: ${String(type)}`);
};

const TYPE_META: Record<ModuleItemType, { label: string; icon: Icon }> = {
  PAGE: { label: 'Page', icon: IconFileText },
  REPOSITORY: { label: 'Repository', icon: IconFolder },
  QUIZ: { label: 'Quiz', icon: IconHelpCircle },
  SLIDE: { label: 'Slides', icon: IconPresentation },
  FORM: { label: 'Form', icon: IconForms },
};

// A form's two lifecycle axes, as an instructor reads them. Both are exhaustive
// Records over their enums, so adding a status or an access mode fails to
// compile here rather than rendering the raw enum name.
const FORM_STATUS_TEXT: Record<FormStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  CLOSED: 'Closed',
};
const FORM_ACCESS_TEXT: Record<FormAccess, string> = {
  PUBLIC: 'Public',
  CLASSROOM: 'Classroom',
};

/** "Public · Open · closes Jan 12, 5:00 PM" — access, status, then the deadline. */
const formSummary = (form: {
  status: FormStatus;
  access: FormAccess;
  closes_at: Date | string | null;
}): string =>
  [
    FORM_ACCESS_TEXT[form.access],
    FORM_STATUS_TEXT[form.status],
    ...(form.closes_at ? [`closes ${formatCloseDate(form.closes_at)}`] : []),
  ].join(' · ');

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
    case 'FORM':
      return item.form?.title ?? '(deleted form)';
    default:
      return unhandledItemType(item.item_type);
  }
};

// Display label + student-visibility for an item. Keep this client-safe: route
// components cannot call server services without pulling Node-only code into
// the browser bundle.
//
// `note` is the optional muted line after the title. Only forms use it today:
// a form carries two axes the other types don't (who may open it, and when it
// stops accepting answers), and neither is recoverable from the Published pill.
const describeItem = (item: ModuleItem): { label: string; published: boolean; note?: string } => {
  switch (item.item_type) {
    case 'PAGE':
      return { label: itemLabel(item), published: !!item.page && !item.page.is_draft };
    case 'REPOSITORY':
      return {
        label: itemLabel(item),
        published: !!item.repository && item.repository.is_published,
      };
    case 'QUIZ':
      return { label: itemLabel(item), published: !!item.quiz && item.quiz.status !== 'DRAFT' };
    case 'SLIDE':
      return { label: itemLabel(item), published: !!item.slide && !item.slide.is_draft };
    // Matches isItemPublished in module.service: a CLOSED form is still shown
    // to students (reading "Closed"); only a DRAFT is hidden.
    case 'FORM':
      return {
        label: itemLabel(item),
        published: !!item.form && item.form.status !== 'DRAFT',
        note: item.form ? formSummary(item.form) : undefined,
      };
    default:
      return unhandledItemType(item.item_type);
  }
};

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
      FORM: new Set(items.filter(i => i.item_type === 'FORM').map(i => i.form_id)),
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
      // A DRAFT form is addable on purpose — an instructor builds the module
      // before opening the form — so the option says so rather than hiding it.
      // The suffix stays plain text because the Select filters on `label`
      // (optionFilterProp), which a JSX pill would break.
      case 'FORM':
        return candidates.forms
          .filter(f => !addedIds.FORM.has(f.id))
          .map(f => ({
            value: f.id,
            label: `${f.title} — ${FORM_ACCESS_TEXT[f.access]} · ${FORM_STATUS_TEXT[f.status]}`,
          }));
      default:
        return unhandledItemType(type);
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
            description="This removes the module. Its items (pages, repositories, quizzes, slides, forms) are kept."
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
          <h2 className="text-sm font-semibold text-ink-1">Content</h2>
          <Button size="small" icon={<IconPlus size={15} />} onClick={() => setAddOpen(true)}>
            Add item
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-10 text-gray-500">
            <div className="font-medium">No items in this module</div>
            <div className="text-sm">
              Use “Add item” to place pages, repositories, quizzes, slides or forms in order.
            </div>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {items.map((item, index) => {
              const meta = TYPE_META[item.item_type];
              const ItemIcon = meta.icon;
              const { label, published, note } = describeItem(item);
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

                  {note && (
                    <span className="shrink-0 text-xs text-ink-3 whitespace-nowrap">{note}</span>
                  )}
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
