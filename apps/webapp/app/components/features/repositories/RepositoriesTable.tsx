import { forwardRef, useMemo, useState } from 'react';
import { Dropdown, Table, Tag } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { titleToIdentifier } from '@classmoji/utils';
import type { MenuProps } from 'antd';
import {
  IconChevronDown,
  IconChevronRight,
  IconDotsVertical,
  IconFileText,
  IconGitPullRequest,
  IconRobot,
  IconUsersGroup,
  IconFolder,
  IconLoader2,
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
  /** The identifier student repos are actually cut under, set once at creation. */
  slug?: string | null;
  type: string;
  team_formation_mode?: string | null;
  is_published: boolean;
  assignments?: AssignmentRow[];
}

interface TreeNode {
  key: string;
  kind: 'repository' | 'assignment';
  name: string;
  repositoryTitle: string;
  repositoryType?: string;
  teamFormationMode?: string | null;
  weight?: number;
  is_published?: boolean;
  is_extra_credit?: boolean;
  repository?: RepositoryRow;
  assignment?: AssignmentRow;
  /** Say push or issue on this row, because its folder carries both. */
  showMode?: boolean;
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
    confirmDelete,
    pending,
  } = useRepositoryActions(actionBase);

  // The primary action (Publish / Sync) is surfaced as an inline button; the
  // overflow menu holds everything else about the repo. There is no detail
  // page any more: grading happens on each assignment's own page.
  const repoMenuItems = (r: RepositoryRow): MenuProps['items'] => [
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
        ]
      : []),
    { type: 'divider' as const },
    { key: 'delete', label: 'Delete', danger: true, icon: <IconTrash size={15} /> },
  ];

  const onRepoMenuClick = (r: RepositoryRow, key: string) => {
    switch (key) {
      case 'autograde':
        return autograde(r);
      case 'update':
        return updateRepositories(r);
      case 'contributions':
        return calculateContributions(r);
      case 'delete':
        return confirmDelete(r.id);
    }
  };

  // ---- a folder per repository, a file per assignment inside it ---------
  // The repository is the template students are cut from; the assignments that
  // submit through it are the work handed out inside that copy. Several
  // assignments may share one repository, and each carries its own weight and
  // publish state, so each gets a row rather than hiding in a menu.
  const treeData: TreeNode[] = useMemo(
    () =>
      repositories.map(r => {
        const assignments = r.assignments ?? [];
        // A repository is normally all push or all issue. When it carries both,
        // each child says which it is, since the folder cannot.
        const mixedModes =
          assignments.some(a => a.submission_mode === 'REPO') &&
          assignments.some(a => a.submission_mode !== 'REPO');
        return {
          key: `repository-${r.id}`,
          kind: 'repository' as const,
          // What Github actually sees: every student repo is `<this>-<login>`.
          // The slug is frozen at creation, so it can drift from a renamed title.
          name: r.slug || titleToIdentifier(r.title),
          repositoryTitle: r.title,
          repositoryType: r.type,
          teamFormationMode: r.team_formation_mode ?? null,
          is_published: r.is_published,
          repository: r,
          children: assignments.length
            ? assignments.map(a => ({
                key: `assignment-${a.id}`,
                kind: 'assignment' as const,
                name: a.title,
                repositoryTitle: r.title,
                // The folder's type applies to everything inside it.
                repositoryType: r.type,
                teamFormationMode: r.team_formation_mode ?? null,
                weight: a.weight,
                is_published: a.is_published,
                is_extra_credit: a.is_extra_credit,
                showMode: mixedModes,
                assignment: a,
              }))
            : undefined,
        };
      }),
    [repositories]
  );

  // Folders open by default, the way the page reads best; what the user
  // collapses stays collapsed, and a repository added later still arrives open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const expandedRowKeys = treeData
    .filter(node => node.children?.length && !collapsed.has(node.key))
    .map(node => node.key);

  const columns = [
    {
      title: 'Repository',
      dataIndex: 'name',
      key: 'name',
      width: 240,
      sorter: (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name),
      render: (_: unknown, record: TreeNode) => {
        if (record.kind === 'assignment') {
          const a = record.assignment!;
          return (
            <span className="inline-flex items-center gap-2 align-middle">
              <IconFileText size={16} className="text-gray-400 shrink-0" />
              <span className="text-ink-1">{record.name}</span>
              {record.showMode && (
                <Tag
                  color={a.submission_mode === 'REPO' ? 'geekblue' : 'purple'}
                  className="m-0 shrink-0 font-medium"
                >
                  {a.submission_mode === 'REPO' ? 'push' : 'issue'}
                </Tag>
              )}
              {record.is_extra_credit && (
                <Tag color="green" className="m-0 shrink-0 font-medium">
                  Extra credit
                </Tag>
              )}
            </span>
          );
        }

        const r = record.repository!;
        // Issues opened in this repository, each its own assignment.
        const issues = (r.assignments ?? []).filter(a => a.submission_mode !== 'REPO');
        // How students submit here. A repository is normally one or the other;
        // both tags show if it somehow carries a mix.
        const hasPush = (r.assignments ?? []).some(a => a.submission_mode === 'REPO');
        return (
          <span className="inline-flex items-center gap-2 align-middle">
            <IconFolder size={18} className="text-gray-400 shrink-0" />
            <span className="font-semibold text-ink-1">{record.name}</span>
            {hasPush && (
              <Tag color="geekblue" className="m-0 shrink-0 font-medium">
                push
              </Tag>
            )}
            {issues.length > 0 && (
              <Tag color="purple" className="m-0 shrink-0 font-medium">
                issue
              </Tag>
            )}
          </span>
        );
      },
    },
    {
      title: 'Type',
      key: 'type',
      width: 130,
      render: (_: unknown, record: TreeNode) => (
        <span className="text-ink-2">
          {prettyType(record.repositoryType)}
          {record.repositoryType === 'GROUP' && (
            <span className="text-ink-3">
              {' '}
              · {record.teamFormationMode === 'SELF_FORMED' ? 'self-formed' : 'instructor teams'}
            </span>
          )}
        </span>
      ),
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: 110,
      // A repository has no weight of its own; the assignments that submit
      // through it carry the whole grade.
      render: (_: unknown, record: TreeNode) =>
        record.kind === 'assignment' ? (
          <span className="text-ink-2 tabular-nums">{record.weight} %</span>
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
              {/* The repository's own page: one roster row per student repo,
                  with a column group per assignment. */}
              <ActionLink
                onClick={() => navigate(`/admin/${classSlug}/repos/${encodeURIComponent(r.title)}`)}
              >
                View
              </ActionLink>
              <ActionLink onClick={() => editRepository(r)}>Edit</ActionLink>
              {pending?.id === r.id ? (
                // The job outlives the request, so the row stays busy until the
                // background batch reports back.
                <span className="inline-flex items-center gap-1.5 text-sm text-ink-3">
                  <IconLoader2 size={14} className="animate-spin" />
                  {pending.label}
                </span>
              ) : r.is_published ? (
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

        return <ActionLink onClick={() => editAssignment(record.assignment!.id)}>Edit</ActionLink>;
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
          expandedRowKeys,
          // A chevron, not antd's plus/minus box: the same disclosure the
          // module cards use. Leaf rows keep the spacer so names stay aligned.
          expandIcon: ({ expanded, onExpand, record, expandable }) =>
            expandable ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${record.name}`}
                onClick={e => {
                  e.stopPropagation();
                  onExpand(record, e);
                }}
                className="float-left mr-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded align-middle text-ink-3 transition-colors hover:bg-stone-100 hover:text-ink-1 dark:hover:bg-neutral-800"
              >
                {expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
              </button>
            ) : (
              <span className="float-left mr-2 inline-block h-5 w-5 shrink-0" />
            ),
          onExpand: (expanded, record) =>
            setCollapsed(prev => {
              const next = new Set(prev);
              if (expanded) next.delete(record.key);
              else next.add(record.key);
              return next;
            }),
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
            slug: r.slug,
            type: r.type,
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
