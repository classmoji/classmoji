import { Button, Tag } from 'antd';
import { IconChevronDown, IconChevronRight, type Icon } from '@tabler/icons-react';

import { usePagePeek } from '~/components/features/pages';
import { TYPE_META } from './moduleItemMeta';
import type { ModuleTreeNode } from './ReadOnlyModulesTree';

export interface StudentModuleCardData {
  id: string;
  title: string;
  description: string | null;
  is_published: boolean;
}

interface StudentModuleCardProps {
  module: StudentModuleCardData;
  index: number;
  /** One leaf per item, already resolved to the viewer's own links and status. */
  leaves: ModuleTreeNode[];
  expanded: boolean;
  onToggle: () => void;
  /** Staff preview drafts; the card chips them instead of hiding them. */
  isStaff: boolean;
}

/** The kind a leaf reads as, and its icon, mirroring the admin card's rows. */
const kindOf = (node: ModuleTreeNode): { label: string; icon: Icon } => {
  if (node.kind === 'repository' || node.kind === 'repo')
    return { label: 'Repository', icon: TYPE_META.REPOSITORY.icon };
  switch (node.resourceIcon) {
    case 'slide':
      return { label: 'Slides', icon: TYPE_META.SLIDE.icon };
    case 'quiz':
      return { label: 'Quiz', icon: TYPE_META.QUIZ.icon };
    case 'form':
      return { label: 'Form', icon: TYPE_META.FORM.icon };
    default:
      return { label: 'Page', icon: TYPE_META.PAGE.icon };
  }
};

/**
 * The student's (and the teaching team's preview) view of one module: the same
 * expandable card and "Kind: title" rows as the instructor's Modules page,
 * with each row's link and status pointing at the viewer's own work instead of
 * editing controls.
 */
const StudentModuleCard = ({
  module,
  index,
  leaves,
  expanded,
  onToggle,
  isStaff,
}: StudentModuleCardProps) => {
  const peek = usePagePeek();
  return (
    <div className="rounded-2xl bg-panel ring-1 ring-line" data-testid={`module-card-${module.id}`}>
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
        {isStaff && !module.is_published && <Tag color="orange">Draft</Tag>}
        <span className="text-xs text-ink-3 whitespace-nowrap">
          {leaves.length} item{leaves.length === 1 ? '' : 's'}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 sm:px-5 pb-3">
          {module.description && (
            <p className="mt-3 mb-1 text-sm text-ink-2 whitespace-pre-wrap">{module.description}</p>
          )}
          {leaves.length === 0 ? (
            <p className="py-3 text-sm text-ink-3">Nothing here yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {leaves.map(node => {
                const { label, icon: RowIcon } = kindOf(node);
                const titleText = typeof node.name === 'string' ? node.name : '';
                // Every row gets the same plain title and the same "View" button;
                // repository rows bring their own action (View / Form a team).
                const view = node.actionNode ? (
                  node.actionNode
                ) : node.pageId && peek ? (
                  // Pages peek in place; everything else opens its own app.
                  <Button
                    size="small"
                    onClick={() => peek.openPeek({ pageId: node.pageId!, title: titleText })}
                  >
                    View
                  </Button>
                ) : node.href ? (
                  <Button size="small" href={node.href} target="_blank" rel="noreferrer">
                    View
                  </Button>
                ) : null;
                return (
                  <li key={node.key} className="flex items-center gap-3 py-2.5">
                    <RowIcon size={18} className="text-gray-400 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-ink-1">
                      <span className="font-semibold mr-2">{label}:</span>
                      {node.name}
                    </span>
                    {node.statusNode}
                    {view}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default StudentModuleCard;
