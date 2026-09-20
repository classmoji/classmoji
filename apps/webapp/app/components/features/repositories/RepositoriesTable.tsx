import { forwardRef, useState } from 'react';
import { Dropdown, Table, Tag } from 'antd';
import type { MenuProps } from 'antd';
import {
  IconChevronDown,
  IconChevronUp,
  IconCloudUpload,
  IconDotsVertical,
  IconEyeOff,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';

import { useRepositoryActions } from './useRepositoryActions';

// An Assignment belongs to a Repository (origin schema: Assignment.repository_id).
interface AssignmentRow {
  id: string;
  title: string;
  weight: number;
  is_extra_credit?: boolean;
  is_published: boolean;
}

// The coursework unit. On origin's current model this is the Prisma `Repository`
// (formerly "Module"). The list route fetches these via
// ClassmojiService.repository.findByClassroomSlug, which includes `assignments`.
interface RepositoryRow {
  id: string;
  title: string;
  type: string;
  is_published: boolean;
  module?: { id: string; title: string; slug: string | null } | null;
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
}: RepositoriesTableProps) => {
  // Controlled expansion so the folder icon can react to expanded state.
  // Issues start collapsed; the row's chevron opens them.
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  // Publish / sync / unpublish / delete + navigation, shared with the module
  // cards so the two surfaces cannot drift.
  const {
    viewRepository,
    editRepository,
    confirmPublish,
    confirmSync,
    confirmUnpublish,
    confirmDelete,
  } = useRepositoryActions(actionBase);

  // The primary action (Publish / Sync) is surfaced as an inline button; the
  // overflow menu keeps only secondary + destructive actions.
  const repoMenuItems = (r: RepositoryRow): MenuProps['items'] => [
    ...(r.is_published
      ? [
          { key: 'unpublish', label: 'Unpublish', icon: <IconEyeOff size={15} /> },
          { type: 'divider' as const },
        ]
      : []),
    { key: 'delete', label: 'Delete', danger: true, icon: <IconTrash size={15} /> },
  ];

  const onRepoMenuClick = (r: RepositoryRow, key: string) => {
    switch (key) {
      case 'unpublish':
        return confirmUnpublish(r.id);
      case 'delete':
        return confirmDelete(r.id);
    }
  };

  // ---- build the tree (Repository -> Assignment) ----
  const treeData: TreeNode[] = repositories.map(r => {
    const children: TreeNode[] = (r.assignments || []).map(a => ({
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
              <ActionLink onClick={() => viewRepository(r)}>View</ActionLink>
              <ActionLink onClick={() => editRepository(r)}>Edit</ActionLink>
              {r.is_published ? (
                <ActionLink
                  className="inline-flex items-center gap-x-1"
                  onClick={() => confirmSync(r.id)}
                >
                  <IconRefresh size={15} />
                  Sync
                </ActionLink>
              ) : (
                <ActionLink
                  className="inline-flex items-center gap-x-1"
                  onClick={() => confirmPublish(r.id)}
                >
                  <IconCloudUpload size={15} />
                  Publish
                </ActionLink>
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

        // assignment — edited through its parent repository's form, so the
        // row carries no actions of its own
        return null;
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
    </div>
  );
};

export default RepositoriesTable;
