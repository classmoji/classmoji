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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1
          className="display"
          style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
        >
          {title}
        </h1>
        <div style={{ flex: 1 }} />
        {headerActions}
      </div>

      {modules.length === 0 ? (
        <div
          className="card"
          style={{
            padding: '28px 18px',
            textAlign: 'center',
            color: 'var(--ink-3)',
            fontSize: 13,
          }}
        >
          {emptyState ?? 'No modules available yet.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 14,
          }}
        >
          {modules.map(m => (
            <ModuleCardItem key={m.id} module={m} />
          ))}
        </div>
      )}
    </div>
  );
}

export default ModulesScreen;
