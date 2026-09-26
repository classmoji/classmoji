import { Fragment } from 'react';
import { Tag } from 'antd';
import { IconChevronDown, IconChevronRight, type Icon } from '@tabler/icons-react';

import { usePagePeek } from '~/components/features/pages';
import { useGitWeb } from '~/hooks/useGitWeb';
import { TYPE_META, typeLabel } from './moduleItemMeta';
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
const kindOf = (node: ModuleTreeNode, isGitLab: boolean): { label: string; icon: Icon } => {
  if (node.kind === 'assignment') return { label: 'Assignment', icon: TYPE_META.REPOSITORY.icon };
  if (node.kind === 'repository' || node.kind === 'repo')
    return { label: typeLabel('REPOSITORY', isGitLab), icon: TYPE_META.REPOSITORY.icon };
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

// Assignment rows share one grid with their header: icon, title, status, due, grade, action.
const ASSIGNMENT_GRID =
  'grid grid-cols-[18px_minmax(0,1fr)_9rem_6rem_6rem_7rem] items-center gap-3';

/** Which heading a leaf sits under: assignments, quizzes and forms are assignments. */
const groupOf = (node: ModuleTreeNode): 'Assignments' | 'Content' =>
  node.kind === 'assignment' ||
  node.kind === 'repository' ||
  node.kind === 'repo' ||
  node.resourceIcon === 'quiz' ||
  node.resourceIcon === 'form'
    ? 'Assignments'
    : 'Content';

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
  const web = useGitWeb();
  // Content reads first, then what is due; each group keeps the module's order.
  const ordered = [
    ...leaves.filter(n => groupOf(n) === 'Content'),
    ...leaves.filter(n => groupOf(n) === 'Assignments'),
  ];
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
            <ul className="flex flex-col">
              {ordered.map((node, i) => {
                const group = groupOf(node);
                const startsGroup = i === 0 || groupOf(ordered[i - 1]) !== group;
                const heading = startsGroup ? (
                  <li className="pt-5 pb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3 first:pt-3">
                    {group}
                  </li>
                ) : null;
                // Assignments read as a table: a header row, then one row per
                // assignment with its status, due date, grade and action in
                // fixed columns. Content rows stay a plain list.
                const isTable = group === 'Assignments';
                const tableHeader =
                  startsGroup && isTable ? (
                    <li
                      className={`${ASSIGNMENT_GRID} px-2 -mx-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-4`}
                    >
                      <span />
                      {/* No label over the title column: the "Assignments"
                          section heading directly above already names it. */}
                      <span />
                      <span>Status</span>
                      <span>Due</span>
                      <span>Grade</span>
                      <span />
                    </li>
                  ) : null;
                const { label, icon: RowIcon } = kindOf(node, web.isGitLab);
                const titleText = typeof node.name === 'string' ? node.name : '';
                // The whole row is the link: pages peek in place, everything
                // else opens its own app. Repository rows keep their team action.
                const open =
                  node.pageId && peek
                    ? () => peek.openPeek({ pageId: node.pageId!, title: titleText })
                    : node.href
                      ? () => window.open(node.href, '_blank', 'noreferrer')
                      : undefined;
                const rowProps = {
                  role: open ? ('link' as const) : undefined,
                  tabIndex: open ? 0 : undefined,
                  onClick: open,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (open && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      open();
                    }
                  },
                };
                // `group` lets the title underline on hover, the usual "this opens
                // something" cue; without it a row only shifts background and
                // reads as decoration.
                const hover = open
                  ? 'group cursor-pointer hover:bg-stone-50 dark:hover:bg-neutral-800'
                  : '';
                const action = node.actionNode && (
                  <span role="presentation" onClick={e => e.stopPropagation()}>
                    {node.actionNode}
                  </span>
                );
                return (
                  <Fragment key={node.key}>
                    {heading}
                    {tableHeader}
                    <li>
                      {isTable ? (
                        <div
                          {...rowProps}
                          className={`${ASSIGNMENT_GRID} py-2.5 px-2 -mx-2 rounded-lg transition-colors ${hover}`}
                        >
                          <RowIcon size={18} className="text-gray-400" />
                          <span className="min-w-0 truncate text-ink-1 group-hover:underline underline-offset-2 decoration-ink-3">
                            {/* The "Assignments" section heading already says what these
                                are; only a quiz or form row needs its kind spelled out. */}
                            {label !== 'Assignment' && (
                              <span className="font-semibold mr-2">{label}:</span>
                            )}
                            {node.name}
                          </span>
                          <span className="min-w-0">{node.submissionNode ?? node.statusNode}</span>
                          <span className="text-xs text-ink-3 whitespace-nowrap">
                            {node.dueText}
                          </span>
                          <span>{node.gradeNode}</span>
                          <span className="flex justify-end">{action}</span>
                        </div>
                      ) : (
                        <div
                          {...rowProps}
                          className={`flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-lg transition-colors ${hover}`}
                        >
                          <RowIcon size={18} className="text-gray-400 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-ink-1 group-hover:underline underline-offset-2 decoration-ink-3">
                            <span className="font-semibold mr-2">{label}:</span>
                            {node.name}
                          </span>
                          {node.statusNode}
                          {action}
                        </div>
                      )}
                    </li>
                  </Fragment>
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
