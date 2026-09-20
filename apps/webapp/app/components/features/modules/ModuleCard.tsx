import { forwardRef, useEffect, useState } from 'react';
import { useFetcher, useNavigate } from 'react-router';
import { App, Dropdown, Switch, Tag, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconClipboardList,
  IconDotsVertical,
  IconFileText,
  IconPencil,
  IconPlus,
  IconPresentation,
  IconTrash,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';

import ModuleFormModal, {
  type ModuleFormModule,
} from '~/routes/admin.$class.modules/ModuleFormModal';
import AssignmentFormModal, {
  type AssignmentKind,
} from '~/components/features/assignments/AssignmentFormModal';
import {
  ASSIGNMENT_TYPE_META,
  assignmentTarget,
  type AssignmentRowData,
} from '~/components/features/assignments/AssignmentsTable';
import AddContentItemModal from './AddContentItemModal';
import {
  TYPE_META,
  describeItem,
  type CandidateContent,
  type ContentItemType,
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
  assignments: AssignmentRowData[];
}

interface ModuleCardProps {
  module: ModuleCardData;
  index: number;
  classSlug: string;
  slidesUrl: string;
  expanded: boolean;
  onToggle: () => void;
  candidates: CandidateContent;
  /** Every repository in the classroom, for the REPO assignment picker. */
  repositories: Array<{ id: string; title: string; is_published: boolean }>;
  boundQuizIds: Set<string>;
  boundFormIds: Set<string>;
}

// antd's Dropdown clones its trigger child to attach its own onClick and ref,
// so the button must forward both; a bare component that ignores them never
// opens the menu. The click still stops at the row so the card doesn't toggle.
const IconMore = forwardRef<
  HTMLButtonElement,
  { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ label, onClick, className: _className, ...rest }, ref) => (
  <button
    {...rest}
    ref={ref}
    type="button"
    aria-label={label}
    onClick={e => {
      e.stopPropagation();
      onClick?.(e);
    }}
    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-gray-200"
  >
    <IconDotsVertical size={16} />
  </button>
));
IconMore.displayName = 'IconMore';

/** A small heading that splits the card's rows into Assignments and Content. */
const GroupHeading = ({ children }: { children: string }) => (
  <li className="pt-5 pb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3 first:pt-3">
    {children}
  </li>
);

/**
 * Every item in a module renders through this one row, whatever its kind:
 * icon, "Kind: title" (kind in bold), an optional muted note (the target an
 * assignment submits through), status pill, Edit, and a menu holding the rest.
 * Clicking the label area opens the item (`onOpen`).
 */
const ItemRow = ({
  icon: RowIcon,
  title,
  note,
  kind,
  published,
  onOpen,
  onEdit,
  menuItems,
  onMenuClick,
}: {
  icon: Icon;
  title: string;
  note?: string | null;
  kind: string;
  published: boolean;
  onOpen: () => void;
  onEdit: () => void;
  menuItems: MenuProps['items'];
  onMenuClick: (key: string) => void;
}) => (
  <li className="flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-lg transition-colors hover:bg-stone-50 dark:hover:bg-neutral-800">
    {/* A real button, so the row opens from the keyboard too. It spans the
        label area; the pill, Edit and the menu sit beside it. */}
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
    >
      <RowIcon size={18} className="text-gray-400 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-ink-1">
        <span className="font-semibold mr-2">{kind}:</span>
        {title}
        {note && <span className="ml-2 text-xs text-ink-3">{note}</span>}
      </span>
    </button>
    <Tag color={published ? 'green' : 'orange'} className="m-0 shrink-0 font-medium">
      {published ? 'Published' : 'Draft'}
    </Tag>
    <button
      type="button"
      onClick={onEdit}
      className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
    >
      Edit
    </button>
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        items: menuItems,
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          onMenuClick(String(key));
        },
      }}
    >
      <IconMore label={`Actions: ${title}`} />
    </Dropdown>
  </li>
);

/**
 * One module, as an expandable card that shows and manages everything it
 * holds: its content (pages, slides) and its assignments, each submitting
 * through a repository, a quiz or a form. One "Add item" row asks which kind
 * to add. Repositories themselves are managed on the Repositories page.
 */
const ModuleCard = ({
  module,
  index,
  classSlug,
  slidesUrl,
  expanded,
  onToggle,
  candidates,
  repositories,
  boundQuizIds,
  boundFormIds,
}: ModuleCardProps) => {
  const navigate = useNavigate();
  const { modal } = App.useApp();
  const moduleFetcher = useFetcher<{ success?: string; error?: string }>();
  const assignmentFetcher = useFetcher<{ success?: string; error?: string }>();

  const [editOpen, setEditOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);
  const [contentType, setContentType] = useState<ContentItemType>('PAGE');
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<AssignmentRowData | null>(null);
  const [presetKind, setPresetKind] = useState<AssignmentKind | undefined>();
  const [error, setError] = useState<string | null>(null);

  const busy = moduleFetcher.state !== 'idle';
  const ownsCoursework = module.assignments.length > 0;
  // Legacy REPOSITORY items are a pre-assignment pointer nobody renders now.
  const contentItems = module.items.filter(i => i.item_type !== 'REPOSITORY');
  const itemCount = module.assignments.length + contentItems.length;

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

  // Move a page/slide up or down among the ordered content items.
  const move = (itemIndex: number, dir: -1 | 1) => {
    const next = itemIndex + dir;
    if (next < 0 || next >= contentItems.length) return;
    const ordered = contentItems.map(i => i.id);
    [ordered[itemIndex], ordered[next]] = [ordered[next], ordered[itemIndex]];
    post('reorderItems', { moduleId: module.id, orderedItemIds: ordered });
  };

  const removeAssignment = (a: AssignmentRowData) =>
    modal.confirm({
      title: 'Delete assignment',
      content:
        'This deletes the assignment along with its submissions and grades. The repository, quiz or form it points at is kept.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () =>
        assignmentFetcher.submit(JSON.stringify({ id: a.id }), {
          method: 'post',
          action: `/admin/${classSlug}/assignments?/delete`,
          encType: 'application/json',
        }),
    });

  const removeContentItem = (moduleItemId: string) =>
    modal.confirm({
      title: 'Remove from module',
      content: 'This removes the item from this module. The item itself is kept.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => post('removeItem', { moduleItemId }),
    });

  const openAssignmentModal = (
    kind: AssignmentKind | undefined,
    editing: AssignmentRowData | null = null
  ) => {
    setEditingAssignment(editing);
    setPresetKind(kind);
    setAssignmentOpen(true);
  };

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
    { type: 'divider' },
    {
      key: 'delete',
      label: ownsCoursework ? 'Delete (move its items first)' : 'Delete module',
      icon: <IconTrash size={15} />,
      danger: true,
      disabled: ownsCoursework,
    },
  ];

  const onMenuClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'edit') setEditOpen(true);
    if (key === 'delete') post('delete', { id: module.id });
  };

  // "Add item" asks which kind. An assignment picks how students submit
  // (a repository, a quiz or a form) in its own modal; a page or slide deck is
  // placed in the module's reading order.
  const addItemMenu: MenuProps['items'] = [
    {
      type: 'group',
      label: 'Assignments',
      children: [
        {
          key: 'ASSIGNMENT',
          icon: <IconClipboardList size={15} />,
          label: 'Assignment — submitted through a repository, a quiz or a form',
        },
      ],
    },
    {
      type: 'group',
      label: 'Content',
      children: [
        { key: 'PAGE', icon: <IconFileText size={15} />, label: 'Page' },
        { key: 'SLIDE', icon: <IconPresentation size={15} />, label: 'Slides' },
      ],
    },
  ];
  const onAddItem: MenuProps['onClick'] = ({ key }) => {
    if (key === 'ASSIGNMENT') openAssignmentModal(undefined);
    else {
      setContentType(key as ContentItemType);
      setContentOpen(true);
    }
  };

  const removeItem = {
    key: 'remove',
    label: 'Remove from module',
    danger: true,
    icon: <IconTrash size={15} />,
  };
  // What the assignment submits through, unless that is just its own title
  // again (a quiz assignment usually carries the quiz's name); then the kind.
  // Where a click on an assignment row goes: the repository page (whose
  // assignment tabs hold the student issues and grading) for a repo
  // assignment, otherwise the list its quiz/form is managed on. An assignment
  // with no target yet just opens the editor.
  // The form's page in the forms app (builder + responses); the admin splat
  // route hands off to it. Falls back to the Forms list for a form with no slug.
  const formHref = (a: AssignmentRowData) =>
    `/admin/${classSlug}/forms${a.form?.slug ? `/${encodeURIComponent(a.form.slug)}` : ''}`;

  // Clicking an assignment row shows its submissions: the repository page
  // (student repos and grades), the quiz's attempts, or the form's responses.
  const openAssignment = (a: AssignmentRowData) => {
    if (a.type === 'REPO' && a.repository?.title) {
      navigate(`/admin/${classSlug}/repos/${encodeURIComponent(a.repository.title)}`);
    } else if (a.type === 'QUIZ' && a.quiz) {
      navigate(`/admin/${classSlug}/quizzes/${a.quiz.id}`);
    } else if (a.type === 'FORM') {
      navigate(formHref(a));
    } else {
      openAssignmentModal(undefined, a);
    }
  };

  // "Edit" edits the thing itself: the repository form, the quiz editor, or
  // the form builder. The assignment's own settings live in the ⋯ menu.
  const editAssignment = (a: AssignmentRowData) => {
    if (a.type === 'REPO' && a.repository?.title) {
      navigate(`/admin/${classSlug}/repos/form?title=${encodeURIComponent(a.repository.title)}`);
    } else if (a.type === 'QUIZ' && a.quiz) {
      navigate(`/admin/${classSlug}/quizzes/form?quizId=${a.quiz.id}`);
    } else if (a.type === 'FORM') {
      navigate(formHref(a));
    } else {
      openAssignmentModal(undefined, a);
    }
  };

  const assignmentNote = (a: AssignmentRowData) => {
    const target = assignmentTarget(a);
    // A REPO assignment names its repo and how students submit through it.
    if (a.type === 'REPO' && target) {
      return `${target} · ${a.submission_mode === 'REPO' ? 'push' : 'issue'}`;
    }
    return target && target !== a.title ? target : (ASSIGNMENT_TYPE_META[a.type]?.label ?? null);
  };
  const deleteAssignmentItem = {
    key: 'remove',
    label: 'Delete assignment',
    danger: true,
    icon: <IconTrash size={15} />,
  };
  // Weight, deadlines and release for a quiz or form assignment live on the
  // assignment, not on the quiz/form Edit opens.
  const assignmentSettingsItem = {
    key: 'settings',
    label: 'Assignment settings',
    icon: <IconPencil size={15} />,
  };

  return (
    <div
      className="rounded-2xl bg-panel ring-1 ring-line"
      data-testid={`module-card-${module.slug ?? module.id}`}
    >
      {/* Header row: number, title, count, visibility, menu */}
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
        <span className="hidden sm:inline text-xs text-ink-3 whitespace-nowrap">
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </span>
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
          <IconMore label={`Module actions: ${module.title}`} />
        </Dropdown>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 sm:px-5 pb-3">
          {error && <div className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</div>}
          {module.description && (
            <p className="mt-3 mb-1 text-sm text-ink-2 whitespace-pre-wrap">{module.description}</p>
          )}

          <ul className="flex flex-col">
            {contentItems.length > 0 && <GroupHeading>Content</GroupHeading>}
            {contentItems.map((item, itemIndex) => {
              const meta = TYPE_META[item.item_type];
              const { label, published } = describeItem(item);
              const edit = () => {
                if (item.item_type === 'PAGE' && item.page) {
                  navigate(`/admin/${classSlug}/pages/${item.page.id}`);
                } else if (item.item_type === 'SLIDE' && item.slide) {
                  window.open(`${slidesUrl}/${item.slide.id}`, '_blank');
                } else if (item.item_type === 'QUIZ') {
                  navigate(`/admin/${classSlug}/quizzes`);
                } else if (item.item_type === 'FORM') {
                  navigate(`/admin/${classSlug}/forms`);
                }
              };
              return (
                <ItemRow
                  key={`item-${item.id}`}
                  icon={meta.icon}
                  title={label}
                  kind={meta.label}
                  published={published}
                  onOpen={edit}
                  onEdit={edit}
                  menuItems={[
                    {
                      key: 'up',
                      label: 'Move up',
                      icon: <IconArrowUp size={15} />,
                      disabled: itemIndex === 0 || busy,
                    },
                    {
                      key: 'down',
                      label: 'Move down',
                      icon: <IconArrowDown size={15} />,
                      disabled: itemIndex === contentItems.length - 1 || busy,
                    },
                    { type: 'divider' as const },
                    removeItem,
                  ]}
                  onMenuClick={key => {
                    if (key === 'up') move(itemIndex, -1);
                    if (key === 'down') move(itemIndex, 1);
                    if (key === 'remove') removeContentItem(item.id);
                  }}
                />
              );
            })}
            {module.assignments.length > 0 && <GroupHeading>Assignments</GroupHeading>}
            {module.assignments.map(a => (
              <ItemRow
                key={`assignment-${a.id}`}
                icon={ASSIGNMENT_TYPE_META[a.type]?.icon ?? IconClipboardList}
                title={a.title}
                note={assignmentNote(a)}
                kind="Assignment"
                published={a.is_published}
                onOpen={() => openAssignment(a)}
                onEdit={() => editAssignment(a)}
                menuItems={[
                  assignmentSettingsItem,
                  { type: 'divider' as const },
                  deleteAssignmentItem,
                ]}
                onMenuClick={key => {
                  if (key === 'settings') openAssignmentModal(undefined, a);
                  if (key === 'remove') removeAssignment(a);
                }}
              />
            ))}
          </ul>

          <Dropdown
            trigger={['click']}
            placement="bottom"
            menu={{ items: addItemMenu, onClick: onAddItem }}
          >
            <button
              type="button"
              data-tour={index === 0 ? 'modules-add-item' : undefined}
              className="flex w-full items-center gap-3 py-2 text-sm text-ink-3 hover:text-ink-1"
            >
              <span className="h-px flex-1 border-t border-dashed border-line" />
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <IconPlus size={14} />
                Add item
              </span>
              <span className="h-px flex-1 border-t border-dashed border-line" />
            </button>
          </Dropdown>
        </div>
      )}

      <ModuleFormModal open={editOpen} module={editModule} onClose={() => setEditOpen(false)} />

      <AssignmentFormModal
        open={assignmentOpen}
        onClose={() => setAssignmentOpen(false)}
        classSlug={classSlug}
        moduleId={module.id}
        modules={[moduleRef]}
        repositories={repositories}
        quizzes={candidates.quizzes}
        forms={candidates.forms}
        pages={candidates.pages}
        slides={candidates.slides}
        boundQuizIds={boundQuizIds}
        boundFormIds={boundFormIds}
        assignment={editingAssignment}
        presetKind={presetKind}
      />

      <AddContentItemModal
        open={contentOpen}
        onClose={() => setContentOpen(false)}
        classSlug={classSlug}
        moduleId={module.id}
        items={contentItems}
        candidates={candidates}
        presetType={contentType}
      />
    </div>
  );
};

export default ModuleCard;
