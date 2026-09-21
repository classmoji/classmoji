import { forwardRef, useState } from 'react';
import { Dropdown, Table, Tag } from 'antd';
import { useNavigate, useParams } from 'react-router';
import type { MenuProps } from 'antd';
import {
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconEyeOff,
  IconFileText,
  IconGitPullRequest,
  IconPencil,
  IconRobot,
  IconUsersGroup,
  IconFolder,
  IconFolderOpen,
  IconTrash,
} from '@tabler/icons-react';

import { useRepositoryActions } from './useRepositoryActions';
import AssignmentFormModal from '~/components/features/assignments/AssignmentFormModal';
import type { AssignmentRowData } from '~/components/features/assignments/AssignmentsTable';

// An Assignment belongs to a Repository (origin schema: Assignment.repository_id).
interface AssignmentRow {
  id: string;
  title: string;
  /** REPO assignments: ISSUE (close an issue) or REPO (a push submits). */
  submission_mode?: string;
  weight: number;
  is_extra_credit?: boolean;
  is_published: boolean;
}

// A repository: the GitHub template students are provisioned from, with the
// assignments that submit through it. The list route fetches these via
// ClassmojiService.repository.findByClassroomSlug, which includes `assignments`.
interface RepositoryRow {
  id: string;
  title: string;
  type: string;
  is_published: boolean;
  assignments?: AssignmentRow[];
}

interface TreeNode {
  key: string;
  kind: 'repository' | 'assignment';
  name: string;
  repositoryTitle: string;
  repositoryType?: string;
  weight?: number;
  is_published?: boolean;
  is_extra_credit?: boolean;
  repository?: RepositoryRow;
  assignment?: AssignmentRow;
  children?: TreeNode[];
}

interface RepositoriesTableProps {
  repositories: RepositoryRow[];
  /**
   * Route whose action handles publish/sync/unpublish/delete. Defaults to the
   * current route (the repositories list); the module page passes
   * `/admin/:class/repos` so the same action serves it.
   */
  actionBase?: string;
  /** Render without the floating card, for use inside another panel. */
  bare?: boolean;
  /**
   * Context for editing an assignment in place. Without it, Edit on an
   * assignment row falls back to opening the editor on the assignment's page.
   */
  editor?: {
    assignments: AssignmentRowData[];
    modules: Array<{ id: string; title: string }>;
    quizzes: Array<{ id: string; name: string; status: string }>;
    forms: Array<{ id: string; title: string; status: string }>;
    pages?: Array<{ id: string; title: string | null }>;
    slides?: Array<{ id: string; title: string | null }>;
  };
}

const prettyType = (type?: string) => (type ? type.charAt(0) + type.slice(1).toLowerCase() : '');

// forwardRef + prop spread so antd overlays that clone the trigger child (and
// attach a ref to anchor a popover/tooltip) keep working if one ever wraps it.
const ActionLink = forwardRef<
  HTMLButtonElement,
  {
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    danger?: boolean;
    children: React.ReactNode;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>
>(({ onClick, danger, children, className, ...rest }, ref) => (
  <button
    {...rest}
    ref={ref}
    type="button"
    onClick={e => {
      e.stopPropagation();
      onClick?.(e);
    }}
    className={`text-sm font-medium ${
      danger
        ? 'text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300'
        : 'text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300'
    } ${className ?? ''}`}
  >
    {children}
  </button>
));
ActionLink.displayName = 'ActionLink';

const RepositoriesTable = ({
  repositories,
  actionBase = '',
  bare = false,
  editor,
}: RepositoriesTableProps) => {
  // Controlled expansion so the folder icon can react to expanded state.
  // Every repository starts open, showing its assignments; the chevron closes it.
  const [expandedKeys, setExpandedKeys] = useState<string[]>(() =>
    repositories
      .filter(r => (r.assignments ?? []).some(a => a.submission_mode !== 'REPO'))
      .map(r => `repository-${r.id}`)
  );

  // Publish / sync / unpublish / delete + navigation, shared with the module
  // cards so the two surfaces cannot drift.
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [editingAssignment, setEditingAssignment] = useState<AssignmentRowData | null>(null);
  const editAssignment = (id: string) => {
    const row = editor?.assignments.find(a => a.id === id) ?? null;
    if (row) setEditingAssignment(row);
    else navigate(`/admin/${classSlug}/assignments/${id}?edit=1`);
  };
  const {
    editRepository,
    updateRepositories,
    autograde,
    calculateContributions,
    confirmPublish,
    confirmSync,
    confirmUnpublish,
    confirmDelete,
  } = useRepositoryActions(actionBase);

  // The primary action (Publish / Sync) is surfaced as an inline button; the
  // overflow menu holds everything else about the repo. There is no detail
  // page any more: grading happens on each assignment's own page.
  const repoMenuItems = (r: RepositoryRow): MenuProps['items'] => [
    { key: 'edit', label: 'Edit repository', icon: <IconPencil size={15} /> },
    ...(r.is_published
      ? [
          { key: 'autograde', label: 'Autograde', icon: <IconRobot size={15} /> },
          {
            key: 'update',
            label: 'Update student repositories',
            icon: <IconGitPullRequest size={15} />,
          },
          ...(r.type === 'GROUP'
            ? [
                {
                  key: 'contributions',
                  label: 'Calculate contributions',
                  icon: <IconUsersGroup size={15} />,
                },
              ]
            : []),
          { type: 'divider' as const },
          { key: 'unpublish', label: 'Unpublish', icon: <IconEyeOff size={15} /> },
        ]
      : []),
    { type: 'divider' as const },
    { key: 'delete', label: 'Delete', danger: true, icon: <IconTrash size={15} /> },
  ];

  const onRepoMenuClick = (r: RepositoryRow, key: string) => {
    switch (key) {
      case 'edit':
        return editRepository(r);
      case 'autograde':
        return autograde(r);
      case 'update':
        return updateRepositories(r);
      case 'contributions':
        return calculateContributions(r);
      case 'unpublish':
        return confirmUnpublish(r.id);
      case 'delete':
        return confirmDelete(r.id);
    }
  };

  // ---- build the tree (Repository -> Assignment) ----
  // Only issue-mode assignments nest under a repository: each one is a GitHub
  // issue opened in every student repo, which is what a child row has always
  // meant here. A push-mode assignment IS the repository (a push submits,
  // nothing is opened), so it is reached from the repository row's View
  // action instead of being listed as if it were an issue.
  const treeData: TreeNode[] = repositories.map(r => {
    const issueAssignments = (r.assignments || []).filter(a => a.submission_mode !== 'REPO');
    const children: TreeNode[] = issueAssignments.map(a => ({
      key: `assignment-${a.id}`,
      kind: 'assignment' as const,
      name: a.title,
      repositoryTitle: r.title,
      repositoryType: r.type,
      weight: a.weight,
      is_published: a.is_published,
      is_extra_credit: a.is_extra_credit,
      assignment: a,
    }));

    return {
      key: `repository-${r.id}`,
      kind: 'repository' as const,
      name: r.title,
      repositoryTitle: r.title,
      repositoryType: r.type,
      is_published: r.is_published,
      repository: r,
      children,
    };
  });

  const columns = [
    {
      title: 'Repository',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      sorter: (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name),
      render: (_: unknown, record: TreeNode) => {
        const level = record.kind === 'repository' ? 0 : 1;
        const hasChildren = (record.children?.length ?? 0) > 0;
        const isExpanded = expandedKeys.includes(record.key);
        const toggle = () =>
          setExpandedKeys(prev =>
            prev.includes(record.key) ? prev.filter(k => k !== record.key) : [...prev, record.key]
          );

        return (
          <div className="flex items-center gap-2" style={{ paddingLeft: level * 24 }}>
            {hasChildren ? (
              <button
                type="button"
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                onClick={e => {
                  e.stopPropagation();
                  toggle();
                }}
                className="shrink-0 inline-flex text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                {isExpanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
              </button>
            ) : (
              <span className="shrink-0 w-4" />
            )}

            {record.kind === 'repository' && (
              <span className="relative inline-flex shrink-0 w-[18px] h-[18px]">
                <IconFolder
                  size={18}
                  className={`absolute inset-0 text-gray-400 transition-opacity duration-200 ease-in-out ${
                    isExpanded ? 'opacity-0' : 'opacity-100'
                  }`}
                />
                <IconFolderOpen
                  size={18}
                  className={`absolute inset-0 text-gray-400 transition-opacity duration-200 ease-in-out ${
                    isExpanded ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </span>
            )}
            {record.kind === 'assignment' && (
              <IconFileText size={16} className="text-gray-400 shrink-0" />
            )}

            <span
              className={record.kind === 'repository' ? 'font-semibold text-ink-1' : 'text-ink-1'}
            >
              {record.name}
            </span>
            {record.kind === 'assignment' && (
              <span className="text-xs text-ink-3">
                {record.assignment?.submission_mode === 'REPO' ? 'push' : 'issue'}
              </span>
            )}
            {record.kind === 'assignment' && record.is_extra_credit && (
              <Tag color="green" bordered={false} className="text-xs m-0">
                EC
              </Tag>
            )}
          </div>
        );
      },
    },
    {
      title: 'Type',
      key: 'type',
      width: 130,
      render: (_: unknown, record: TreeNode) => (
        <span className="text-ink-2">{prettyType(record.repositoryType)}</span>
      ),
    },
    {
      // Grading weight lives on assignments; repositories carry none.
      title: 'Weight (%)',
      key: 'weight',
      width: 110,
      render: (_: unknown, record: TreeNode) =>
        record.kind === 'assignment' ? (
          <span className="text-ink-2">{record.weight ?? 0} %</span>
        ) : null,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_: unknown, record: TreeNode) => (
        <Tag color={record.is_published ? 'green' : 'orange'} className="font-semibold">
          {record.is_published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_: unknown, record: TreeNode) => {
        if (record.kind === 'repository') {
          const r = record.repository!;
          return (
            <div className="flex items-center gap-x-4 whitespace-nowrap">
              {(() => {
                const pushAssignments = (r.assignments ?? []).filter(
                  a => a.submission_mode === 'REPO'
                );
                if (pushAssignments.length === 0) return null;
                if (pushAssignments.length === 1) {
                  return (
                    <ActionLink
                      onClick={() =>
                        navigate(`/admin/${classSlug}/assignments/${pushAssignments[0].id}`)
                      }
                    >
                      View
                    </ActionLink>
                  );
                }
                return (
                  <Dropdown
                    trigger={['click']}
                    placement="bottomLeft"
                    menu={{
                      items: pushAssignments.map(a => ({ key: a.id, label: a.title })),
                      onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        navigate(`/admin/${classSlug}/assignments/${key}`);
                      },
                    }}
                  >
                    <ActionLink>View</ActionLink>
                  </Dropdown>
                );
              })()}
              <ActionLink onClick={() => editRepository(r)}>Edit</ActionLink>
              {r.is_published ? (
                <ActionLink onClick={() => confirmSync(r.id)}>Sync</ActionLink>
              ) : (
                <ActionLink onClick={() => confirmPublish(r.id)}>Publish</ActionLink>
              )}
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{
                  items: repoMenuItems(r),
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    onRepoMenuClick(r, key);
                  },
                }}
              >
                <button
                  type="button"
                  aria-label="More actions"
                  onClick={e => e.stopPropagation()}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-gray-200"
                >
                  <IconDotsVertical size={18} />
                </button>
              </Dropdown>
            </div>
          );
        }

        // assignment (issue mode): View opens its page, like the repo row's
        // action does for push mode; Edit opens the editor right here
        // (or on that page when this table was given no editor context).
        const a = record.assignment!;
        return (
          <div className="flex items-center gap-x-4 whitespace-nowrap">
            <ActionLink onClick={() => navigate(`/admin/${classSlug}/assignments/${a.id}`)}>
              View
            </ActionLink>
            <ActionLink onClick={() => editAssignment(a.id)}>Edit</ActionLink>
          </div>
        );
      },
    },
  ];

  return (
    <div
      className={
        bare
          ? ''
          : 'rounded-2xl overflow-hidden bg-panel ring-1 ring-line min-h-[calc(100vh-10rem)] p-5 sm:p-6'
      }
    >
      <Table
        columns={columns}
        dataSource={treeData}
        rowKey="key"
        rowHoverable={false}
        size="middle"
        expandable={{
          showExpandColumn: false,
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: keys => setExpandedKeys(keys as string[]),
        }}
        scroll={{ x: 'max-content' }}
        pagination={{
          pageSize: 25,
          showSizeChanger: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} repositories`,
        }}
        locale={{
          emptyText: (
            <div className="text-center py-12 text-gray-500">
              <div className="font-medium">No repositories created yet</div>
              <div className="text-sm">Create your first repository to get started!</div>
            </div>
          ),
        }}
      />
      {editor && (
        <AssignmentFormModal
          open={editingAssignment !== null}
          onClose={() => setEditingAssignment(null)}
          classSlug={classSlug!}
          modules={editor.modules}
          repositories={repositories.map(r => ({
            id: r.id,
            title: r.title,
            is_published: r.is_published,
          }))}
          quizzes={editor.quizzes}
          forms={editor.forms}
          pages={editor.pages}
          slides={editor.slides}
          boundQuizIds={
            new Set(editor.assignments.map(a => a.quiz?.id).filter(Boolean) as string[])
          }
          boundFormIds={
            new Set(editor.assignments.map(a => a.form?.id).filter(Boolean) as string[])
          }
          assignment={editingAssignment}
        />
      )}
    </div>
  );
};

export default RepositoriesTable;
