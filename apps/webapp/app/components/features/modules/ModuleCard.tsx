import { useEffect, useState } from 'react';
import { useFetcher, useNavigate } from 'react-router';
import { Button, Dropdown, Popconfirm, Switch, Tag, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import dayjs from 'dayjs';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCloudUpload,
  IconDotsVertical,
  IconEyeOff,
  IconFileText,
  IconFolder,
  IconForms,
  IconHelpCircle,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';

import ModuleFormModal, {
  type ModuleFormModule,
} from '~/routes/admin.$class.modules/ModuleFormModal';
import AssignmentFormModal from '~/components/features/assignments/AssignmentFormModal';
import {
  assignmentTarget,
  ASSIGNMENT_TYPE_META,
  type AssignmentRowData,
} from '~/components/features/assignments/AssignmentsTable';
import { useRepositoryActions } from '~/components/features/repositories/useRepositoryActions';
import AddContentItemModal from './AddContentItemModal';
import {
  TYPE_META,
  describeItem,
  type CandidateContent,
  type ModuleItemLike,
} from './moduleItemMeta';

/** A module as the Modules page loader hands it over: everything it owns. */
export interface ModuleCardData {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  position: number;
  is_published: boolean;
  is_public: boolean;
  items: ModuleItemLike[];
  repositories: Array<{
    id: string;
    title: string;
    type: string;
    is_published: boolean;
    assignments: Array<{ id: string; title: string; weight: number; is_published: boolean }>;
    _count: { git_repos: number };
  }>;
  assignments: AssignmentRowData[];
}

interface ModuleCardProps {
  module: ModuleCardData;
  index: number;
  classSlug: string;
  expanded: boolean;
  onToggle: () => void;
  candidates: CandidateContent;
  boundQuizIds: Set<string>;
  boundFormIds: Set<string>;
}

const prettyType = (type: string) => type.charAt(0) + type.slice(1).toLowerCase();

const StatusPill = ({ published }: { published: boolean }) => (
  <Tag color={published ? 'green' : 'orange'} className="m-0 shrink-0 font-medium">
    {published ? 'Published' : 'Draft'}
  </Tag>
);

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-1 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4 select-none">
    {children}
  </div>
);

/** The dashed "+ Add …" row that ends each section, as on Coursera. */
const AddRow = ({
  label,
  onClick,
  tour,
}: {
  label: string;
  onClick: () => void;
  tour?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    data-tour={tour}
    className="flex w-full items-center gap-3 py-1.5 text-sm text-ink-3 hover:text-ink-1 group"
  >
    <span className="h-px flex-1 border-t border-dashed border-line" />
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <IconPlus size={14} />
      {label}
    </span>
    <span className="h-px flex-1 border-t border-dashed border-line" />
  </button>
);

const ActionLink = ({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={e => {
      e.stopPropagation();
      onClick();
    }}
    className={`inline-flex items-center gap-1 text-sm font-medium ${
      danger
        ? 'text-rose-600 hover:text-rose-700 dark:text-rose-400'
        : 'text-sky-600 hover:text-sky-700 dark:text-sky-400'
    }`}
  >
    {children}
  </button>
);

/**
 * One module, as an expandable card that shows and manages everything the
 * module owns in place: its repositories, its assignments, and its ordered
 * content. Nothing here needs the module detail page.
 */
const ModuleCard = ({
  module,
  index,
  classSlug,
  expanded,
  onToggle,
  candidates,
  boundQuizIds,
  boundFormIds,
}: ModuleCardProps) => {
  const navigate = useNavigate();
  const moduleFetcher = useFetcher<{ success?: string; error?: string }>();
  const assignmentFetcher = useFetcher<{ success?: string; error?: string }>();
  const repoActions = useRepositoryActions(`/admin/${classSlug}/repos`);

  const [editOpen, setEditOpen] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<AssignmentRowData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = moduleFetcher.state !== 'idle';
  const ownsCoursework = module.repositories.length > 0 || module.assignments.length > 0;
  // Legacy REPOSITORY items duplicate the Repositories section; hide them.
  const contentItems = module.items.filter(i => i.item_type !== 'REPOSITORY');

  useEffect(() => {
    if (moduleFetcher.state === 'idle' && moduleFetcher.data?.error) {
      setError(moduleFetcher.data.error);
    }
  }, [moduleFetcher.state, moduleFetcher.data]);

  const post = (action: string, payload: Record<string, unknown>) =>
    moduleFetcher.submit(JSON.stringify(payload), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/${action}`,
      encType: 'application/json',
    });

  const move = (itemIndex: number, dir: -1 | 1) => {
    const next = itemIndex + dir;
    if (next < 0 || next >= contentItems.length) return;
    const ordered = contentItems.map(i => i.id);
    [ordered[itemIndex], ordered[next]] = [ordered[next], ordered[itemIndex]];
    post('reorderItems', { moduleId: module.id, orderedItemIds: ordered });
  };

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

  const menuItems: MenuProps['items'] = [
    { key: 'edit', label: 'Edit title & description', icon: <IconPencil size={15} /> },
    {
      key: 'public',
      label: module.is_public ? 'Hide from course website' : 'Show on course website',
      icon: <IconWorld size={15} />,
      disabled: !module.is_published,
    },
    { type: 'divider' },
    {
      key: 'delete',
      label: ownsCoursework ? 'Delete (move its coursework first)' : 'Delete module',
      icon: <IconTrash size={15} />,
      danger: true,
      disabled: ownsCoursework,
    },
  ];

  const onMenuClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'edit') setEditOpen(true);
    if (key === 'public') post('setPublic', { id: module.id, isPublic: !module.is_public });
    if (key === 'delete') post('delete', { id: module.id });
  };

  const repoMenu = (published: boolean): MenuProps['items'] => [
    ...(published
      ? [
          { key: 'unpublish', label: 'Unpublish', icon: <IconEyeOff size={15} /> },
          { type: 'divider' as const },
        ]
      : []),
    { key: 'delete', label: 'Delete', danger: true, icon: <IconTrash size={15} /> },
  ];

  const counts = [
    `${module.repositories.length} repo${module.repositories.length === 1 ? '' : 's'}`,
    `${module.assignments.length} assignment${module.assignments.length === 1 ? '' : 's'}`,
    `${contentItems.length} item${contentItems.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return (
    <div
      className={`rounded-2xl bg-panel ring-1 ring-line ${expanded ? '' : ''}`}
      data-testid={`module-card-${module.slug ?? module.id}`}
    >
      {/* Header row: number, title, counts, visibility, menu */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') onToggle();
        }}
        className="flex items-center gap-3 px-4 sm:px-5 py-3.5 cursor-pointer select-none"
      >
        <span className="text-ink-3">
          {expanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
        </span>
        <span className="w-6 text-right tabular-nums text-ink-3 font-semibold">{index + 1}</span>
        <span className="h-5 border-l border-line" />
        <span className="min-w-0 flex-1 truncate font-semibold text-ink-1">{module.title}</span>
        <span className="hidden sm:inline text-xs text-ink-3 whitespace-nowrap">{counts}</span>
        {module.is_public && module.is_published && (
          <Tooltip title="Shown on the course website">
            <IconWorld size={16} className="text-sky-500 shrink-0" />
          </Tooltip>
        )}
        <Tooltip title="When on, students see this module (published items only).">
          <div
            role="presentation"
            className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer whitespace-nowrap"
            onClick={e => e.stopPropagation()}
          >
            <Switch
              size="small"
              checked={module.is_published}
              loading={busy}
              onChange={checked => post('setPublished', { id: module.id, isPublished: checked })}
            />
            Visible to students
          </div>
        </Tooltip>
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{ items: menuItems, onClick: onMenuClick }}
        >
          <button
            type="button"
            aria-label={`Module actions: ${module.title}`}
            onClick={e => e.stopPropagation()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-gray-200"
          >
            <IconDotsVertical size={18} />
          </button>
        </Dropdown>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 sm:px-5 pb-4">
          {error && <div className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</div>}
          {module.description ? (
            <p className="mt-3 text-sm text-ink-2 whitespace-pre-wrap">{module.description}</p>
          ) : (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="mt-3 text-sm text-ink-3 hover:text-ink-1"
            >
              Add module description
            </button>
          )}

          {/* Repositories */}
          <SectionLabel>Repositories</SectionLabel>
          <ul className="flex flex-col divide-y divide-line">
            {module.repositories.map(r => (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <IconFolder size={18} className="text-gray-400 shrink-0" />
                <button
                  type="button"
                  onClick={() => repoActions.viewRepository(r)}
                  className="min-w-0 flex-1 truncate text-left text-ink-1 hover:underline"
                >
                  {r.title}
                </button>
                <span className="hidden sm:inline text-xs text-ink-3 whitespace-nowrap">
                  {prettyType(r.type)} · {r._count.git_repos} student repo
                  {r._count.git_repos === 1 ? '' : 's'}
                </span>
                <StatusPill published={r.is_published} />
                <div className="flex items-center gap-3 whitespace-nowrap">
                  <ActionLink onClick={() => repoActions.editRepository(r)}>Edit</ActionLink>
                  {r.is_published ? (
                    <ActionLink onClick={() => repoActions.confirmSync(r.id)}>
                      <IconRefresh size={14} />
                      Sync
                    </ActionLink>
                  ) : (
                    <ActionLink onClick={() => repoActions.confirmPublish(r.id)}>
                      <IconCloudUpload size={14} />
                      Publish
                    </ActionLink>
                  )}
                  <Dropdown
                    trigger={['click']}
                    placement="bottomRight"
                    menu={{
                      items: repoMenu(r.is_published),
                      onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        if (key === 'unpublish') repoActions.confirmUnpublish(r.id);
                        if (key === 'delete') repoActions.confirmDelete(r.id);
                      },
                    }}
                  >
                    <button
                      type="button"
                      aria-label="More actions"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-gray-200"
                    >
                      <IconDotsVertical size={16} />
                    </button>
                  </Dropdown>
                </div>
              </li>
            ))}
          </ul>
          <AddRow
            label="Add repository"
            tour={index === 0 ? 'repos-new' : undefined}
            onClick={() => navigate(`/admin/${classSlug}/repos/form?module=${module.id}`)}
          />

          {/* Assignments */}
          <SectionLabel>Assignments</SectionLabel>
          <ul className="flex flex-col divide-y divide-line">
            {module.assignments.map(a => {
              const meta = ASSIGNMENT_TYPE_META[a.type];
              const KindIcon =
                a.type === 'QUIZ' ? IconHelpCircle : a.type === 'FORM' ? IconForms : IconFileText;
              const target = assignmentTarget(a);
              return (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <KindIcon size={18} className="text-gray-400 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-ink-1">
                    {a.title}
                    {target && <span className="text-ink-3"> · {target}</span>}
                  </span>
                  {a.is_extra_credit && (
                    <Tag color="green" bordered={false} className="m-0 text-xs">
                      EC
                    </Tag>
                  )}
                  <Tag color={meta?.color} className="m-0 shrink-0">
                    {meta?.label ?? a.type}
                  </Tag>
                  <span className="text-xs text-ink-2 tabular-nums whitespace-nowrap">
                    {a.weight}%
                  </span>
                  <span className="hidden sm:inline text-xs text-ink-3 whitespace-nowrap">
                    {a.student_deadline
                      ? `due ${dayjs(a.student_deadline).format('MMM D')}`
                      : 'no due date'}
                  </span>
                  <StatusPill published={a.is_published} />
                  <div className="flex items-center gap-3 whitespace-nowrap">
                    <ActionLink
                      onClick={() => {
                        setEditingAssignment(a);
                        setAssignmentOpen(true);
                      }}
                    >
                      Edit
                    </ActionLink>
                    <Popconfirm
                      title="Delete assignment"
                      description={
                        a.type === 'REPO'
                          ? 'This deletes the assignment and every student submission and grade under it.'
                          : 'This removes the assignment from its module. The quiz or form itself is kept.'
                      }
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      cancelText="Cancel"
                      onConfirm={() => deleteAssignment(a)}
                    >
                      <button
                        type="button"
                        className="text-sm font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400"
                      >
                        Delete
                      </button>
                    </Popconfirm>
                  </div>
                </li>
              );
            })}
          </ul>
          <AddRow
            label="Add assignment"
            onClick={() => {
              setEditingAssignment(null);
              setAssignmentOpen(true);
            }}
          />

          {/* Content */}
          <SectionLabel>Content</SectionLabel>
          <ul className="flex flex-col divide-y divide-line">
            {contentItems.map((item, itemIndex) => {
              const meta = TYPE_META[item.item_type];
              const ItemIcon = meta.icon;
              const { label, published, note } = describeItem(item);
              return (
                <li key={item.id} className="flex items-center gap-3 py-2">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={itemIndex === 0 || busy}
                      onClick={() => move(itemIndex, -1)}
                      className="text-gray-400 hover:text-ink-1 disabled:opacity-30 disabled:hover:text-gray-400"
                    >
                      <IconArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={itemIndex === contentItems.length - 1 || busy}
                      onClick={() => move(itemIndex, 1)}
                      className="text-gray-400 hover:text-ink-1 disabled:opacity-30 disabled:hover:text-gray-400"
                    >
                      <IconArrowDown size={14} />
                    </button>
                  </div>
                  <ItemIcon size={18} className="text-gray-400 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-ink-1">{label}</span>
                  {note && (
                    <span className="shrink-0 text-xs text-ink-3 whitespace-nowrap">{note}</span>
                  )}
                  <Tag className="m-0 shrink-0">{meta.label}</Tag>
                  <StatusPill published={published} />
                  <Popconfirm
                    title="Remove from module"
                    description="This removes the item from this module. The item itself is kept."
                    okText="Remove"
                    cancelText="Cancel"
                    onConfirm={() => post('removeItem', { moduleItemId: item.id })}
                  >
                    <Button type="text" size="small" danger icon={<IconTrash size={15} />} />
                  </Popconfirm>
                </li>
              );
            })}
          </ul>
          <AddRow label="Add item" onClick={() => setAddItemOpen(true)} />
        </div>
      )}

      <ModuleFormModal open={editOpen} module={editModule} onClose={() => setEditOpen(false)} />

      <AssignmentFormModal
        open={assignmentOpen}
        onClose={() => setAssignmentOpen(false)}
        classSlug={classSlug}
        moduleId={module.id}
        modules={[moduleRef]}
        repositoriesByModule={{
          [module.id]: module.repositories.map(r => ({ id: r.id, title: r.title })),
        }}
        quizzes={candidates.quizzes}
        forms={candidates.forms}
        boundQuizIds={boundQuizIds}
        boundFormIds={boundFormIds}
        assignment={editingAssignment}
      />

      <AddContentItemModal
        open={addItemOpen}
        onClose={() => setAddItemOpen(false)}
        classSlug={classSlug}
        moduleId={module.id}
        items={contentItems}
        candidates={candidates}
      />
    </div>
  );
};

export default ModuleCard;
