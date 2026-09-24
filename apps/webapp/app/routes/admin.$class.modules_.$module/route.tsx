import { useEffect, useState } from 'react';
import { data, useFetcher, useNavigate, useParams } from 'react-router';
import { Button, Tag, Popconfirm, Switch, Tooltip } from 'antd';
import {
  IconChevronLeft,
  IconStack2,
  IconPencil,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconPlus,
} from '@tabler/icons-react';

import { ClassmojiService } from '@classmoji/services';
import FolderTabs from '~/components/ui/FolderTabs';
import AddContentItemModal from '~/components/features/modules/AddContentItemModal';
import { TYPE_META, describeItem } from '~/components/features/modules/moduleItemMeta';
import AssignmentsTable, {
  type AssignmentRowData,
} from '~/components/features/assignments/AssignmentsTable';
import AssignmentFormModal from '~/components/features/assignments/AssignmentFormModal';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import ModuleFormModal, { type ModuleFormModule } from '../admin.$class.modules/ModuleFormModal';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, module: moduleSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  const found = await ClassmojiService.module.findByClassroomSlugAndModuleSlug(
    classSlug!,
    moduleSlug!
  );
  if (!found) {
    throw data('Module not found', { status: 404 });
  }

  // The module with everything it owns, plus the pickers' candidate content
  // and every repository a REPO assignment may submit through.
  const [module, candidates, repositories, tags] = await Promise.all([
    ClassmojiService.module.listModuleContents(found.id, classroom.id),
    ClassmojiService.module.getCandidateContent(classroom.id),
    ClassmojiService.repository.findByClassroomId(classroom.id),
    ClassmojiService.organizationTag.findByClassroomId(classroom.id),
  ]);
  if (!module) {
    throw data('Module not found', { status: 404 });
  }

  // Quiz/form ids bound anywhere in the classroom (each binds to one assignment).
  const bound = await ClassmojiService.assignment.listForClassroom(classroom.id);

  return {
    module,
    candidates,
    // Team tags, for an instructor-assigned team assignment created here.
    tags: tags.map(t => ({ id: t.id, name: t.name })),
    repositories: repositories.map(r => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      type: r.type,
      is_published: r.is_published,
    })),
    boundQuizIds: bound.map(a => a.quiz_id).filter(Boolean) as string[],
    boundFormIds: bound.map(a => a.form_id).filter(Boolean) as string[],
  };
};

const ModuleDetail = ({ loaderData }: Route.ComponentProps) => {
  const { module, candidates, repositories, boundQuizIds, boundFormIds, tags } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();

  // Navigates away after delete; item ops revalidate in place.
  const deleteFetcher = useFetcher<{ success?: string; error?: string }>();
  const itemFetcher = useFetcher<{ success?: string; error?: string }>();
  const assignmentFetcher = useFetcher<{ success?: string; error?: string }>();

  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<AssignmentRowData | null>(null);

  // Legacy REPOSITORY items are a pre-assignment pointer nobody renders now.
  const items = module.items.filter(i => i.item_type !== 'REPOSITORY');
  const busy = itemFetcher.state !== 'idle';

  // Return to the list once the module is deleted.
  useEffect(() => {
    if (deleteFetcher.state === 'idle' && deleteFetcher.data?.success) {
      navigate(`/admin/${classSlug}/modules`);
    }
  }, [deleteFetcher.state, deleteFetcher.data, classSlug, navigate]);

  const post = (action: string, payload: Record<string, unknown>) =>
    itemFetcher.submit(JSON.stringify(payload), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/${action}`,
      encType: 'application/json',
    });

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

  const deleteAssignment = (a: AssignmentRowData) =>
    assignmentFetcher.submit(JSON.stringify({ id: a.id }), {
      method: 'post',
      action: `/admin/${classSlug}/assignments?/delete`,
      encType: 'application/json',
    });

  const editModule: ModuleFormModule = {
    id: module.id,
    title: module.title,
    description: module.description,
  };

  const moduleRef = {
    id: module.id,
    title: module.title,
    slug: module.slug,
    position: module.position,
  };
  const assignmentRows: AssignmentRowData[] = module.assignments.map(a => ({
    ...(a as unknown as AssignmentRowData),
    module: moduleRef,
  }));
  const tabItems = [
    {
      key: 'assignments',
      label: 'Assignments',
      extra: (
        <Button
          icon={<IconPlus size={16} />}
          onClick={() => {
            setEditingAssignment(null);
            setAssignmentModalOpen(true);
          }}
        >
          New assignment
        </Button>
      ),
      children: (
        <AssignmentsTable
          assignments={assignmentRows}
          classSlug={classSlug!}
          showModuleColumn={false}
          onEdit={a => {
            setEditingAssignment(a);
            setAssignmentModalOpen(true);
          }}
          onDelete={deleteAssignment}
          busy={assignmentFetcher.state !== 'idle'}
          emptyText="No assignments in this module yet"
        />
      ),
    },
    {
      key: 'content',
      label: 'Content',
      extra: (
        <Button icon={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
          Add item
        </Button>
      ),
      children:
        items.length === 0 ? (
          <div className="text-center py-10 text-gray-500">
            <div className="font-medium">No content in this module</div>
            <div className="text-sm">
              Use “Add item” to place pages, slides, quizzes or forms in reading order.
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
        ),
    },
  ];

  const ownsCoursework = module.assignments.length > 0;

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
            description={
              ownsCoursework
                ? 'Move or delete its assignments first; a module that still owns coursework cannot be deleted.'
                : 'This removes the module. Its content items (pages, quizzes, slides, forms) are kept.'
            }
            okText="Delete"
            okButtonProps={{ danger: true, disabled: ownsCoursework }}
            cancelText="Cancel"
            onConfirm={deleteModule}
          >
            <Button danger icon={<IconTrash size={16} />}>
              Delete
            </Button>
          </Popconfirm>
        </div>
      </div>

      {deleteFetcher.data?.error && (
        <div className="mb-4 text-sm text-rose-600 dark:text-rose-400">
          {deleteFetcher.data.error}
        </div>
      )}

      {module.description && (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 mb-4 text-sm text-ink-2 whitespace-pre-wrap">
          {module.description}
        </div>
      )}

      <FolderTabs items={tabItems} defaultActiveKey="assignments" panelClassName="min-h-[300px]" />

      <ModuleFormModal open={editOpen} module={editModule} onClose={() => setEditOpen(false)} />

      <AssignmentFormModal
        open={assignmentModalOpen}
        onClose={() => setAssignmentModalOpen(false)}
        classSlug={classSlug!}
        moduleId={module.id}
        modules={[moduleRef]}
        repositories={repositories}
        quizzes={candidates.quizzes}
        forms={candidates.forms}
        pages={candidates.pages}
        slides={candidates.slides}
        boundQuizIds={new Set(boundQuizIds)}
        boundFormIds={new Set(boundFormIds)}
        assignment={editingAssignment}
        tags={tags}
      />

      <AddContentItemModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        classSlug={classSlug!}
        moduleId={module.id}
        items={items}
        candidates={candidates}
      />
    </div>
  );
};

export default ModuleDetail;
