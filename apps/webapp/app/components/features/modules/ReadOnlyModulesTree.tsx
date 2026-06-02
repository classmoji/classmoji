import { useMemo, useState } from 'react';
import { Table } from 'antd';
import {
  IconBrandGithub,
  IconChevronDown,
  IconChevronUp,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconPresentation,
  IconRobot,
} from '@tabler/icons-react';

/**
 * Generic, read-only module tree renderer shared by the student and assistant
 * module pages. It only renders the nodes it is given — each route builds its
 * own role-scoped nodes from its own scoped loader, so this component never
 * fetches or exposes data on its own. No owner/management actions live here.
 */
export interface ModuleTreeNode {
  key: string;
  kind: 'module' | 'repo' | 'assignment' | 'resource';
  level: number;
  name: React.ReactNode;
  typeText?: string;
  weightText?: string;
  statusNode?: React.ReactNode;
  actionNode?: React.ReactNode;
  href?: string;
  resourceIcon?: 'page' | 'slide' | 'quiz';
  children?: ModuleTreeNode[];
}

export const prettyType = (type?: string | null) =>
  type ? type.charAt(0) + type.slice(1).toLowerCase() : '';

// Build a GitHub URL for a repo. Names may be "owner/repo" or just "repo".
export const repoGithubUrl = (name: string, gitOrgLogin?: string | null) =>
  name.includes('/')
    ? `https://github.com/${name}`
    : gitOrgLogin
      ? `https://github.com/${gitOrgLogin}/${name}`
      : null;

// Turn a module's / assignment's linked pages, slides and quizzes into read-only
// resource leaf nodes (each opens the relevant app in a new tab).
export const buildResourceLeaves = (
  input: {
    pages?: Array<{ page: { id: string; title: string } }>;
    slides?: Array<{ slide: { id: string; title: string } }>;
    quizzes?: Array<{ id: string; name: string }>;
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
        : IconFileText;
  return <Icon size={15} className="text-ink-3 shrink-0" />;
};

const ReadOnlyModulesTree = ({ nodes }: { nodes: ModuleTreeNode[] }) => {
  const allKeys = useMemo(() => collectExpandableKeys(nodes), [nodes]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(allKeys);

  const columns = [
    {
      title: 'Module',
      key: 'name',
      width: '40%',
      render: (_: unknown, record: ModuleTreeNode) => {
        const hasChildren = (record.children?.length ?? 0) > 0;
        const isExpanded = expandedKeys.includes(record.key);
        const toggle = () =>
          setExpandedKeys(keys =>
            keys.includes(record.key)
              ? keys.filter(k => k !== record.key)
              : [...keys, record.key]
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
            {record.href ? (
              <a
                href={record.href}
                target="_blank"
                rel="noreferrer"
                className="text-sky-600 hover:text-sky-700 dark:text-sky-400"
              >
                {record.name}
              </a>
            ) : (
              <span className={record.kind === 'module' ? 'font-semibold text-ink-1' : 'text-ink-1'}>
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
      width: '12%',
      render: (_: unknown, r: ModuleTreeNode) =>
        r.typeText ? <span className="text-ink-2">{r.typeText}</span> : <span className="text-ink-3">—</span>,
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: '12%',
      render: (_: unknown, r: ModuleTreeNode) =>
        r.weightText ? <span className="text-ink-2">{r.weightText}</span> : <span className="text-ink-3">—</span>,
    },
    {
      title: 'Status',
      key: 'status',
      width: '16%',
      render: (_: unknown, r: ModuleTreeNode) => r.statusNode ?? null,
    },
    {
      title: '',
      key: 'actions',
      width: '20%',
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
