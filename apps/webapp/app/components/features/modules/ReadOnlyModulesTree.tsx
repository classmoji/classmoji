import { useMemo, useState } from 'react';
import { Table, Tag } from 'antd';
import {
  IconBrandGithub,
  IconChevronDown,
  IconChevronUp,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconForms,
  IconPresentation,
  IconRobot,
} from '@tabler/icons-react';
import { PageLink } from '~/components/features/pages';

/**
 * Generic, read-only module tree renderer shared by the student and assistant
 * module pages. It only renders the nodes it is given — each route builds its
 * own role-scoped nodes from its own scoped loader, so this component never
 * fetches or exposes data on its own. No owner/management actions live here.
 */
export interface ModuleTreeNode {
  key: string;
  kind: 'module' | 'repository' | 'repo' | 'assignment' | 'resource';
  level: number;
  name: React.ReactNode;
  typeText?: string;
  weightText?: string;
  statusNode?: React.ReactNode;
  actionNode?: React.ReactNode;
  autogradingNode?: React.ReactNode;
  href?: string;
  resourceIcon?: 'page' | 'slide' | 'quiz' | 'form';
  /**
   * Set on page leaves only. Inside the student/assistant shell it makes the
   * row open the peek drawer instead of a new tab, so a lab guide can be read
   * without leaving the tree it was linked from. `href` stays as the fallback
   * for shells with no drawer (admin) — see PageLink.
   */
  pageId?: string;
  children?: ModuleTreeNode[];
}

// Whether any node in the tree carries an autograding cell — used to add the
// "Autograding" column only where it's relevant (e.g. the student repos view),
// keeping it out of trees that don't use it (e.g. the assistant modules view).
const hasAutogradingNodes = (nodes: ModuleTreeNode[]): boolean =>
  nodes.some(
    n => n.autogradingNode != null || (n.children ? hasAutogradingNodes(n.children) : false)
  );

export const prettyType = (type?: string | null) =>
  type ? type.charAt(0) + type.slice(1).toLowerCase() : '';

// Build a GitHub URL for a repo. Names may be "owner/repo" or just "repo".
export const repoGithubUrl = (name: string, gitOrgLogin?: string | null) =>
  name.includes('/')
    ? `https://github.com/${name}`
    : gitOrgLogin
      ? `https://github.com/${gitOrgLogin}/${name}`
      : null;

/**
 * A form's close time as a member reads it: "Jan 12, 5:00 PM". Unlike an
 * assignment's date-only student deadline, the clock matters — a form stops
 * accepting answers at an instant, not at the end of a day. Shared with the
 * admin module builder so both surfaces phrase the deadline identically.
 */
export const formatCloseDate = (value: Date | string): string =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Whether a form no longer accepts answers: closed by hand, or past its close time. */
export const isFormClosed = (form: { status: string; closes_at: Date | string | null }): boolean =>
  form.status === 'CLOSED' ||
  (!!form.closes_at && new Date(form.closes_at).getTime() <= Date.now());

// Turn a module's / assignment's linked pages, slides, quizzes and forms into
// read-only resource leaf nodes (each opens the relevant app in a new tab).
export const buildResourceLeaves = (
  input: {
    pages?: Array<{ page: { id: string; title: string } }>;
    slides?: Array<{ slide: { id: string; title: string } }>;
    quizzes?: Array<{ id: string; name: string }>;
    forms?: Array<{
      id: string;
      title: string;
      slug: string;
      status: string;
      access: string;
      closes_at: Date | string | null;
    }>;
  },
  level: number,
  keyPrefix: string,
  ctx: { classSlug: string; slidesUrl: string; pagesUrl: string; quizzesHref: string }
): ModuleTreeNode[] => {
  const out: ModuleTreeNode[] = [];
  (input.pages ?? []).forEach(({ page }) =>
    out.push({
      key: `${keyPrefix}-page-${page.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'page',
      name: page.title,
      pageId: page.id,
      href: `${ctx.pagesUrl}/${ctx.classSlug}/${page.id}`,
    })
  );
  (input.slides ?? []).forEach(({ slide }) =>
    out.push({
      key: `${keyPrefix}-slide-${slide.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'slide',
      name: slide.title,
      href: `${ctx.slidesUrl}/${slide.id}`,
    })
  );
  (input.quizzes ?? []).forEach(q =>
    out.push({
      key: `${keyPrefix}-quiz-${q.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'quiz',
      name: q.name,
      href: ctx.quizzesHref,
    })
  );
  // Forms live in the pages app: /{class}/forms/{slug}. The close time is this
  // leaf's deadline, so it reads where an assignment's "due …" reads. A DRAFT
  // only ever reaches here in the staff preview — listForClassroom drops it for
  // students — and it says so rather than showing a close time it can't honour.
  (input.forms ?? []).forEach(form => {
    out.push({
      key: `${keyPrefix}-form-${form.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'form',
      name: form.title,
      typeText: form.access === 'PUBLIC' ? 'Public form' : 'Classroom form',
      statusNode:
        form.status === 'DRAFT' ? (
          <Tag color="orange">Draft</Tag>
        ) : isFormClosed(form) ? (
          <Tag>Closed</Tag>
        ) : form.closes_at ? (
          <span className="text-xs text-ink-3 whitespace-nowrap">
            Closes {formatCloseDate(form.closes_at)}
          </span>
        ) : null,
      href: `${ctx.pagesUrl}/${ctx.classSlug}/forms/${form.slug}`,
    });
  });
  return out;
};

const collectExpandableKeys = (nodes: ModuleTreeNode[]): string[] => {
  const keys: string[] = [];
  const walk = (ns: ModuleTreeNode[]) => {
    for (const n of ns) {
      if (n.children?.length) {
        keys.push(n.key);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return keys;
};

const NodeIcon = ({ node, isExpanded }: { node: ModuleTreeNode; isExpanded: boolean }) => {
  if (node.kind === 'module') {
    return (
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
    );
  }
  if (node.kind === 'repository') {
    // Top-level repository (the standalone Repositories tab): a prominent repo
    // header, mirroring the folder icon's role for modules.
    return <IconBrandGithub size={18} className="text-gray-400 shrink-0" />;
  }
  if (node.kind === 'repo') {
    return <IconBrandGithub size={16} className="text-gray-400 shrink-0" />;
  }
  if (node.kind === 'assignment') {
    return <IconFileText size={16} className="text-gray-400 shrink-0" />;
  }
  const Icon =
    node.resourceIcon === 'slide'
      ? IconPresentation
      : node.resourceIcon === 'quiz'
        ? IconRobot
        : node.resourceIcon === 'form'
          ? IconForms
          : IconFileText;
  return <Icon size={15} className="text-ink-3 shrink-0" />;
};

const ReadOnlyModulesTree = ({
  nodes,
  nameColumnTitle = 'Module',
}: {
  nodes: ModuleTreeNode[];
  /** First-column header. Defaults to 'Module'; the repos tab passes 'Repository'. */
  nameColumnTitle?: string;
}) => {
  const allKeys = useMemo(() => collectExpandableKeys(nodes), [nodes]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(allKeys);

  const columns = [
    {
      title: nameColumnTitle,
      key: 'name',
      render: (_: unknown, record: ModuleTreeNode) => {
        const hasChildren = (record.children?.length ?? 0) > 0;
        const isExpanded = expandedKeys.includes(record.key);
        const toggle = () =>
          setExpandedKeys(keys =>
            keys.includes(record.key) ? keys.filter(k => k !== record.key) : [...keys, record.key]
          );

        return (
          <div className="flex items-center gap-2" style={{ paddingLeft: record.level * 24 }}>
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
            <NodeIcon node={record} isExpanded={isExpanded} />
            {record.pageId && record.href ? (
              // Pages peek in place; slides and quizzes keep opening their own
              // app in a new tab, which is the only sensible thing for them.
              <PageLink
                pageId={record.pageId}
                title={typeof record.name === 'string' ? record.name : ''}
                href={record.href}
                className="text-sky-600 hover:text-sky-700 dark:text-sky-400"
              >
                {record.name}
              </PageLink>
            ) : record.href ? (
              <a
                href={record.href}
                target="_blank"
                rel="noreferrer"
                className="text-sky-600 hover:text-sky-700 dark:text-sky-400"
              >
                {record.name}
              </a>
            ) : (
              <span
                className={
                  record.kind === 'module' || record.kind === 'repository'
                    ? 'font-semibold text-ink-1'
                    : 'text-ink-1'
                }
              >
                {record.name}
              </span>
            )}
          </div>
        );
      },
    },
    {
      title: 'Type',
      key: 'type',
      render: (_: unknown, r: ModuleTreeNode) =>
        r.typeText ? (
          <span className="text-ink-2">{r.typeText}</span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      render: (_: unknown, r: ModuleTreeNode) =>
        r.weightText ? (
          <span className="text-ink-2">{r.weightText}</span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      title: 'Status',
      key: 'status',

      render: (_: unknown, r: ModuleTreeNode) => r.statusNode ?? null,
    },
    ...(hasAutogradingNodes(nodes)
      ? [
          {
            title: 'Autograding',
            key: 'autograding',
            render: (_: unknown, r: ModuleTreeNode) => r.autogradingNode ?? null,
          },
        ]
      : []),
    {
      title: 'Actions',
      key: 'actions',
      // No fixed width: the column hugs its content ("View" / "Open repo" /
      // "Open issue"), left-aligned, instead of reserving a wide empty gap.
      render: (_: unknown, r: ModuleTreeNode) => r.actionNode ?? null,
    },
  ];

  return (
    <div className="rounded-2xl overflow-hidden bg-panel min-h-[calc(100vh-10rem)] p-5 sm:p-6">
      <Table
        columns={columns as Parameters<typeof Table>[0]['columns']}
        dataSource={nodes}
        rowKey="key"
        rowHoverable={false}
        size="middle"
        pagination={false}
        scroll={{ x: 'max-content' }}
        expandable={{
          showExpandColumn: false,
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: keys => setExpandedKeys(keys as string[]),
        }}
      />
    </div>
  );
};

export default ReadOnlyModulesTree;
