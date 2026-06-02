import { useState } from 'react';

/**
 * Shared "file folder" tab styling for the platform (overlapping, rounded-top
 * tabs that connect into the panel below). This is the canonical implementation
 * of the look that the dashboards, grading, assignments, settings and quiz
 * pages each previously hand-rolled.
 *
 * - `FolderTabBar` is the controlled primitive: it renders just the row of
 *   folder tabs. Use it when the active tab also drives other logic (filtering,
 *   counts, a custom panel) and the parent owns the state + content panel.
 * - `FolderTabs` is the convenience wrapper: it manages its own active state and
 *   renders the connected content panel. Use it for simple tab sections.
 */

export interface FolderTabDef<K extends string = string> {
  key: K;
  label: React.ReactNode;
  count?: number;
  /** Renders the tab in a destructive (red) style, e.g. a "Danger Zone" tab. */
  danger?: boolean;
}

interface FolderTabBarProps<K extends string> {
  tabs: FolderTabDef<K>[];
  activeKey: K;
  onChange: (key: K) => void;
  className?: string;
}

export function FolderTabBar<K extends string>({
  tabs,
  activeKey,
  onChange,
  className = '',
}: FolderTabBarProps<K>) {
  return (
    <div className={`flex -mb-px relative overflow-x-auto ${className}`}>
      {tabs.map((tab, idx) => {
        const isActive = tab.key === activeKey;
        const baseZ = tabs.length - idx;
        const style: React.CSSProperties =
          isActive && !tab.danger
            ? { zIndex: 10, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
            : { zIndex: isActive ? 10 : baseZ };
        const stateClasses = isActive
          ? `bg-panel border-line border-b-transparent ${
              tab.danger ? 'text-red-600 dark:text-red-400' : ''
            }`
          : `bg-nav-hover border-line ${
              tab.danger
                ? 'text-red-500/80 dark:text-red-400/80 hover:text-red-600 dark:hover:text-red-400'
                : 'text-ink-3 hover:text-gray-800 dark:hover:text-gray-200'
            }`;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            style={style}
            className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
              idx > 0 ? '-ml-2' : ''
            } ${stateClasses}`}
          >
            {tab.label}
            {typeof tab.count === 'number' && (
              <span className={`ml-2 text-xs tabular-nums ${isActive ? 'text-ink-3' : 'text-ink-4'}`}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface FolderTabItem extends FolderTabDef {
  children: React.ReactNode;
  /** Optional action rendered right-aligned on the tab row when this tab is active. */
  extra?: React.ReactNode;
}

interface FolderTabsProps {
  items: FolderTabItem[];
  defaultActiveKey?: string;
  /** Extra classes for the content panel (e.g. min-height). */
  panelClassName?: string;
}

const FolderTabs = ({ items, defaultActiveKey, panelClassName = '' }: FolderTabsProps) => {
  const [active, setActive] = useState(defaultActiveKey ?? items[0]?.key);
  const activeItem = items.find(i => i.key === active) ?? items[0];

  return (
    <div className="flex flex-col">
      <div className="flex items-end justify-between gap-3">
        <FolderTabBar tabs={items} activeKey={active} onChange={setActive} />
        {activeItem?.extra && <div className="shrink-0 pb-1">{activeItem.extra}</div>}
      </div>
      <section
        className={`rounded-2xl rounded-tl-none bg-panel border border-line p-5 sm:p-6 ${panelClassName}`}
      >
        {activeItem?.children}
      </section>
    </div>
  );
};

export default FolderTabs;
