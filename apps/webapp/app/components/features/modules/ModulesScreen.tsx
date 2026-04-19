import type { ReactNode } from 'react';
import { ModuleCardItem } from './ModuleCardItem';
import type { ModuleCard } from './modulesTypes';

interface ModulesScreenProps {
  modules: ModuleCard[];
  /** Optional title override. Defaults to "Modules". */
  title?: string;
  /** Slot on the right of the title (e.g., admin "New module" button). */
  headerActions?: ReactNode;
  /** Empty state override. */
  emptyState?: ReactNode;
}

export function ModulesScreen({
  modules,
  title = 'Modules',
  headerActions,
  emptyState,
}: ModulesScreenProps) {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5">
        <h1
          className="display m-0"
          style={{ fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
        >
          {title}
        </h1>
        <div className="flex-1" />
        {headerActions}
      </div>

      {modules.length === 0 ? (
        <div
          className="panel text-center"
          style={{
            padding: '28px 18px',
            color: 'var(--ink-3)',
            fontSize: 13,
          }}
        >
          {emptyState ?? 'No modules available yet.'}
        </div>
      ) : (
        <div className="reveal-enter flex flex-col gap-2.5">
          {modules.map(m => (
            <ModuleCardItem key={m.id} module={m} />
          ))}
        </div>
      )}
    </div>
  );
}

export default ModulesScreen;
