import { forwardRef, useMemo, useState } from 'react';
import { App, Dropdown, Table, Tag } from 'antd';
import type { MenuProps } from 'antd';
import { useNavigate, useParams } from 'react-router';
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
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react';

import { EditableCell } from '~/components';
import { ActionTypes } from '~/constants';
import LocalStorage from '~/utils/localStorage';
import { useGlobalFetcher } from '~/hooks';

// An Assignment belongs to a Repository (origin schema: Assignment.repository_id).
interface AssignmentRow {
  id: string;
  title: string;
  weight: number;
  is_published: boolean;
}

// The coursework unit. On origin's current model this is the Prisma `Repository`
// (formerly "Module"). The list route fetches these via
// ClassmojiService.repository.findByClassroomSlug, which includes `assignments`.
interface RepositoryRow {
  id: string;
  title: string;
  type: string;
  weight: number;
  is_published: boolean;
  is_extra_credit?: boolean;
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

interface AssignmentTableProps {
  // Origin's route passes the (filtered) list of repositories under this prop name.
  assignments: RepositoryRow[];
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

const AssignmentTable = ({ assignments: repositories }: AssignmentTableProps) => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { fetcher, notify } = useGlobalFetcher();
  const { modal } = App.useApp();

  // Controlled expansion so the folder icon can react to expanded state.
  // Default to fully expanded so the structure is visible.
  const allExpandableKeys = useMemo(() => {
    const keys: string[] = [];
    repositories.forEach(r => {
      if ((r.assignments?.length ?? 0) > 0) keys.push(`repository-${r.id}`);
    });
    return keys;
  }, [repositories]);
  // Expanded by default (including nodes that appear after a revalidation),
  // minus the rows the user has explicitly collapsed.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const expandedKeys = useMemo(
    () => allExpandableKeys.filter(k => !collapsedKeys.has(k)),
    [allExpandableKeys, collapsedKeys]
  );

  // ---- repository-level actions (reuse existing list action.ts named actions) ----
  const handleUpdateWeight = (repositoryId: string, weight: number) => {
    fetcher!.submit(
      { assignment_id: repositoryId, weight },
      {
        method: 'post',
        action: '?/updateAssignment',
        encType: 'application/json',
      }
    );
  };

  const publishRepository = (id: string) => {
    fetcher!.submit(
      { assignment_id: id },
      {
        method: 'post',
        action: '?/publish',
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  const syncRepository = (id: string) => {
    fetcher!.submit(
      { assignment_id: id },
      {
        method: 'post',
        action: '?/sync',
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  const unpublishRepository = (id: string) => {
    fetcher!.submit(
      { assignment_id: id },
      {
        method: 'post',
        action: '?/unpublish',
        encType: 'application/json',
      }
    );
  };

  const deleteRepository = (id: string) => {
    notify(ActionTypes.DELETE_ASSIGNMENT, 'Deleting repository...');
    fetcher!.submit(
      { assignment_id: id },
      {
        method: 'delete',
        action: '?/delete',
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  const viewRepository = (record: RepositoryRow) =>
    navigate(`/admin/${classSlug}/repos/${record.title}`, {
      state: { assignment: record },
    });
  const editRepository = (record: RepositoryRow) =>
    navigate(`/admin/${classSlug}/repos/form?title=${record.title}`, {
      state: { assignment: record },
    });

  // ---- overflow ("⋯") menu: secondary + destructive actions, kept clear of
  // the inline View/Edit links. Confirmations use modal.confirm since antd
  // Popconfirm doesn't compose inside a Dropdown menu item.
  const confirmSync = (id: string) =>
    modal.confirm({
      title: 'Sync repository',
      content: 'This updates all student repositories with the latest changes.',
      okText: 'Sync',
      cancelText: 'Cancel',
      onOk: () => syncRepository(id),
    });

  const confirmPublish = (id: string) =>
    modal.confirm({
      title: 'Publish repository',
      content: 'This makes the repository available to all students.',
      okText: 'Publish',
      cancelText: 'Cancel',
      onOk: () => publishRepository(id),
    });

  const confirmUnpublish = (id: string) =>
    modal.confirm({
      title: 'Unpublish repository',
      content: 'This hides the repository from students. Repositories are not deleted.',
      okText: 'Unpublish',
      cancelText: 'Cancel',
      onOk: () => unpublishRepository(id),
    });

  const confirmDelete = (id: string) =>
    modal.confirm({
      title: 'Delete repository',
      content: 'This permanently deletes the repository and its assignments.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => deleteRepository(id),
    });

  // The primary action (Publish / Sync) is surfaced as an inline button; the
  // overflow menu keeps only secondary + destructive actions.
  const repoMenuItems = (r: RepositoryRow): MenuProps['items'] => [
    ...(r.is_published
      ? [{ key: 'unpublish', label: 'Unpublish', icon: <IconEyeOff size={15} /> }, { type: 'divider' as const }]
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
      assignment: a,
    }));

    return {
      key: `repository-${r.id}`,
      kind: 'repository' as const,
      name: r.title,
      repositoryTitle: r.title,
      repositoryType: r.type,
      weight: r.weight,
      is_published: r.is_published,
      is_extra_credit: r.is_extra_credit,
      repository: r,
      children,
    };
  });

  // Total reflects the repository weights shown on the top-level rows (these are
  // the values meant to sum to 100% across the class).
  const totalWeight = repositories.reduce((acc, r) => acc + (r.weight ?? 0), 0);

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
          setCollapsedKeys(prev => {
            const next = new Set(prev);
            if (next.has(record.key)) next.delete(record.key);
            else next.add(record.key);
            return next;
          });

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
            {record.kind === 'repository' && record.is_extra_credit && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-1 text-xs font-medium leading-none text-amber-700/90 dark:text-amber-300/90">
                <IconStarFilled size={11} className="-mt-px shrink-0 text-amber-500/80" />
                Extra credit
              </span>
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
      title: 'Weight (%)',
      key: 'weight',
      width: 110,
      render: (_: unknown, record: TreeNode) =>
        record.kind === 'repository' ? (
          <EditableCell
            record={{ id: record.repository!.id, weight: record.weight ?? 0 }}
            dataIndex="weight"
            onUpdate={(recordId, value) => handleUpdateWeight(recordId as string, value as number)}
            format="number"
          />
        ) : (
          <span className="text-ink-2">{record.weight ?? 0} %</span>
        ),
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
                <ActionLink className="inline-flex items-center gap-x-1" onClick={() => confirmSync(r.id)}>
                  <IconRefresh size={15} />
                  Sync
                </ActionLink>
              ) : (
                <ActionLink className="inline-flex items-center gap-x-1" onClick={() => confirmPublish(r.id)}>
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

        // assignment — edited through its parent repository's form
        return (
          <div className="flex items-center gap-x-4 whitespace-nowrap">
            <ActionLink
              onClick={() =>
                navigate(`/admin/${classSlug}/repos/form?title=${record.repositoryTitle}`, {
                  state: { assignment: record.repository },
                })
              }
            >
              Edit
            </ActionLink>
          </div>
        );
      },
    },
  ];

  return (
    <div className="rounded-2xl overflow-hidden bg-panel ring-1 ring-line min-h-[calc(100vh-10rem)] p-5 sm:p-6">
      <Table
        columns={columns}
        dataSource={treeData}
        rowKey="key"
        rowHoverable={false}
        size="middle"
        expandable={{
          showExpandColumn: false,
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: keys =>
            setCollapsedKeys(
              new Set(allExpandableKeys.filter(k => !(keys as string[]).includes(k)))
            ),
        }}
        scroll={{ x: 'max-content' }}
        pagination={{
          pageSize: 25,
          showSizeChanger: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} repositories`,
        }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} className="font-semibold">
              Total
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1}></Table.Summary.Cell>
            <Table.Summary.Cell index={2} className="font-bold">
              <span className={totalWeight === 100 ? 'text-green-600' : 'text-red-600'}>
                {totalWeight}%
              </span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3}></Table.Summary.Cell>
            <Table.Summary.Cell index={4}></Table.Summary.Cell>
          </Table.Summary.Row>
        )}
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

export default AssignmentTable;
