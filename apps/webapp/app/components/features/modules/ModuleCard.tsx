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
  IconFolder,
  IconHelpCircle,
  IconForms,
  IconGripVertical,
  IconLoader2,
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
import { mergeDragProps, type CourseworkCardDrag } from './useCourseworkDrag';
import { useRepositoryActions } from '~/components/features/repositories/useRepositoryActions';
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
  /** Team tags in this classroom, for an instructor-assigned team assignment. */
  tags?: { id: string; name: string }[];
  /** Drag-to-reorder wiring for the card itself; absent when searching. */
  dragProps?: Record<string, unknown>;
  dragHandleProps?: Record<string, unknown>;
  dragClassName?: string;
  /**
   * This card's slice of the page-level coursework drag: the rows it shows, in
   * the order they are being dragged into, and the handlers that move them
   * within this module or into another one.
   */
  coursework: CourseworkCardDrag;
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

/**
 * The grip that arms a drag. Dragging is armed from here rather than from the
 * whole row, so the links, menus and switches inside a row keep working.
 * `handleProps` is absent while the list cannot be reordered (during a search).
 */
const DragHandle = ({
  props,
  label,
  // Which hover reveals it: a row inside a card, or the card itself. Written
  // out in full because Tailwind only generates class names it can see.
  reveal = 'group-hover/row:opacity-100',
}: {
  props?: Record<string, unknown>;
  label: string;
  reveal?: 'group-hover/row:opacity-100' | 'group-hover/card:opacity-100';
}) => (
  <span
    {...props}
    role="presentation"
    title={props ? label : undefined}
    className={`shrink-0 text-gray-300 dark:text-neutral-600 transition-opacity opacity-0 ${
      props ? `cursor-grab active:cursor-grabbing ${reveal}` : ''
    }`}
  >
    <IconGripVertical size={16} />
  </span>
);

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
  action,
  busyLabel,
  menuItems,
  onMenuClick,
  dragProps,
  dragHandleProps,
  dragClassName = '',
}: {
  icon: Icon;
  title: string;
  note?: string | null;
  kind: string;
  published: boolean;
  onOpen: () => void;
  onEdit: () => void;
  /** An extra inline action beside Edit (a REPO assignment's Publish). */
  action?: { label: string; onClick: () => void };
  /** Set while that action's background work runs; it replaces the action. */
  busyLabel?: string;
  menuItems: MenuProps['items'];
  onMenuClick: (key: string) => void;
  dragProps?: Record<string, unknown>;
  dragHandleProps?: Record<string, unknown>;
  dragClassName?: string;
}) => (
  <li
    {...dragProps}
    className={`group/row flex items-center gap-2 py-2.5 px-2 -mx-2 rounded-lg transition-colors hover:bg-stone-50 dark:hover:bg-neutral-800 ${dragClassName}`}
  >
    <DragHandle props={dragHandleProps} label={`Drag to reorder: ${title}`} />
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
    {busyLabel ? (
      <span className="inline-flex items-center gap-1.5 text-sm text-ink-3 whitespace-nowrap">
        <IconLoader2 size={14} className="animate-spin" />
        {busyLabel}
      </span>
    ) : (
      action && (
        <button
          type="button"
          onClick={action.onClick}
          className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
        >
          {action.label}
        </button>
      )
    )}
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
  tags = [],
  coursework,
  dragProps,
  dragHandleProps,
  dragClassName = '',
}: ModuleCardProps) => {
  const navigate = useNavigate();
  // Publish acts on the repository a REPO assignment submits through, via the
  // repositories route's action — the same one the Repositories page posts to,
  // so the two surfaces cannot drift.
  const { confirmPublishAssignment, confirmSync, pending } = useRepositoryActions(
    `/admin/${classSlug}/repos`
  );
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
  // The rows as the page is showing them: its order, including a drag that has
  // not come back from the server yet. Legacy REPOSITORY items are filtered out
  // there, since they are a pre-assignment pointer nobody renders now.
  const contentItems = coursework.content.items as ModuleItemLike[];
  const assignments = coursework.assignments.items as AssignmentRowData[];
  const ownsCoursework = assignments.length > 0;
  const itemCount = assignments.length + contentItems.length;

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
          key: 'ASSIGNMENT_REPO',
          icon: <IconFolder size={15} />,
          label: 'Repository assignment',
        },
        { key: 'ASSIGNMENT_QUIZ', icon: <IconHelpCircle size={15} />, label: 'Quiz assignment' },
        { key: 'ASSIGNMENT_FORM', icon: <IconForms size={15} />, label: 'Form assignment' },
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
    if (key === 'ASSIGNMENT_REPO') openAssignmentModal('REPO');
    else if (key === 'ASSIGNMENT_QUIZ') openAssignmentModal('QUIZ');
    else if (key === 'ASSIGNMENT_FORM') openAssignmentModal('FORM');
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
  // The form's page in the forms app (builder + responses); the admin splat
  // route hands off to it. Falls back to the Forms list for a form with no slug.
  const formHref = (a: AssignmentRowData) =>
    `/admin/${classSlug}/forms${a.form?.slug ? `/${encodeURIComponent(a.form.slug)}` : ''}`;

  // Clicking an assignment row shows its submissions: the assignment page
  // (one roster with submission state and grades), the quiz's attempts, or
  // the form's responses.
  const openAssignment = (a: AssignmentRowData) => {
    if (a.type === 'REPO' && a.repository) {
      navigate(`/admin/${classSlug}/assignments/${a.id}`);
    } else if (a.type === 'QUIZ' && a.quiz) {
      navigate(`/admin/${classSlug}/quizzes/${a.quiz.id}`);
    } else if (a.type === 'FORM') {
      navigate(formHref(a));
    } else {
      openAssignmentModal(undefined, a);
    }
  };

  // "Edit" edits the assignment: its weight, deadlines, release and what it
  // submits through. Editing the thing it submits through (the repository
  // form, the quiz editor, the form builder) is the ⋯ menu's job.
  const editAssignment = (a: AssignmentRowData) => openAssignmentModal(undefined, a);

  // Where the ⋯ "Edit repository / quiz / form" item goes, or null when the
  // assignment has no target yet.
  const editTargetHref = (a: AssignmentRowData): string | null => {
    if (a.type === 'REPO' && a.repository?.title) {
      return `/admin/${classSlug}/repos/form?title=${encodeURIComponent(a.repository.title)}`;
    }
    if (a.type === 'QUIZ' && a.quiz) return `/admin/${classSlug}/quizzes/form?quizId=${a.quiz.id}`;
    if (a.type === 'FORM') return formHref(a);
    return null;
  };
  const editTargetLabel = (a: AssignmentRowData) =>
    a.type === 'REPO' ? 'Edit repository' : a.type === 'QUIZ' ? 'Edit quiz' : 'Edit form';

  const assignmentNote = (a: AssignmentRowData) => {
    const target = assignmentTarget(a);
    const weight = `${a.weight}%${a.is_extra_credit ? ' extra credit' : ''}`;
    // A REPO assignment names its repo and how students submit through it —
    // unless the repo carries the assignment's own name, which is the push-mode
    // default and would just say it twice.
    if (a.type === 'REPO' && target) {
      const mode = a.submission_mode === 'REPO' ? 'push' : 'issue';
      return target === a.title ? `${mode} · ${weight}` : `${target} · ${mode} · ${weight}`;
    }
    const base =
      target && target !== a.title ? target : (ASSIGNMENT_TYPE_META[a.type]?.label ?? null);
    return base ? `${base} · ${weight}` : weight;
  };
  const deleteAssignmentItem = {
    key: 'remove',
    label: 'Delete assignment',
    danger: true,
    icon: <IconTrash size={15} />,
  };

  return (
    <div
      {...mergeDragProps(dragProps, coursework.cardProps)}
      className={`group/card rounded-2xl bg-panel ring-1 transition-shadow ${
        coursework.isDropTarget ? 'ring-2 ring-sky-500' : 'ring-line'
      } ${dragClassName}`}
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
        className="flex items-center gap-2 px-4 sm:px-5 py-3.5 cursor-pointer select-none"
      >
        <DragHandle
          props={dragHandleProps}
          label={`Drag to reorder: ${module.title}`}
          reveal="group-hover/card:opacity-100"
        />
        <span className="text-ink-3">
          {expanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
        </span>
        <span className="w-6 text-right tabular-nums text-ink-3 font-semibold">{index + 1}</span>
        <span className="mx-1 h-5 border-l border-line" />
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
                  dragProps={coursework.content.rowProps(item.id)}
                  dragHandleProps={coursework.content.handleProps(item.id)}
                  dragClassName={coursework.content.rowClassName(item.id)}
                />
              );
            })}
            {assignments.length > 0 && <GroupHeading>Assignments</GroupHeading>}
            {assignments.map(a => {
              // Publish is a property of the repository the assignment submits
              // through, so only REPO assignments with one can offer it. Its
              // published state comes from the classroom's repository list.
              // Publishing opens the assignment to students; the action
              // provisions its repository first when that has not happened yet.
              const repoId = a.type === 'REPO' ? a.repository?.id : undefined;
              const needsRepo = repoId
                ? !(repositories.find(r => r.id === repoId)?.is_published ?? false)
                : false;
              return (
                <ItemRow
                  key={`assignment-${a.id}`}
                  icon={ASSIGNMENT_TYPE_META[a.type]?.icon ?? IconClipboardList}
                  title={a.title}
                  note={assignmentNote(a)}
                  kind="Assignment"
                  published={a.is_published}
                  onOpen={() => openAssignment(a)}
                  onEdit={() => editAssignment(a)}
                  busyLabel={
                    // Publishing queues background work, so the row keeps
                    // saying so until that work reports back.
                    pending && (pending.id === a.id || pending.id === repoId)
                      ? pending.label
                      : undefined
                  }
                  action={
                    // Something outstanding — the assignment is a draft, or its
                    // repositories do not exist — offers Publish. Once both are
                    // done the row offers Sync, as the Repositories page does.
                    !a.is_published || needsRepo
                      ? {
                          label: a.is_published ? 'Create repos' : 'Publish',
                          onClick: () =>
                            confirmPublishAssignment(a.id, {
                              needsRepo,
                              assignmentPublished: a.is_published,
                            }),
                        }
                      : repoId
                        ? { label: 'Sync', onClick: () => confirmSync(repoId) }
                        : undefined
                  }
                  menuItems={[
                    ...(editTargetHref(a)
                      ? [
                          {
                            key: 'edit-target',
                            label: editTargetLabel(a),
                            icon: <IconPencil size={15} />,
                          },
                          { type: 'divider' as const },
                        ]
                      : []),
                    deleteAssignmentItem,
                  ]}
                  onMenuClick={key => {
                    if (key === 'edit-target') {
                      const href = editTargetHref(a);
                      if (href) navigate(href);
                    }
                    if (key === 'remove') removeAssignment(a);
                  }}
                  dragProps={coursework.assignments.rowProps(a.id)}
                  dragHandleProps={coursework.assignments.handleProps(a.id)}
                  dragClassName={coursework.assignments.rowClassName(a.id)}
                />
              );
            })}
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
        tags={tags}
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
